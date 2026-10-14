import { expect, test } from "./fixtures";
import { pluginUnderTestId, readOnDemandStorageValue, targetPluginId, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

// Regression test for issue #6: a command cache built for an older plugin version
// could register wrappers for command IDs that no longer exist, making the first
// invocation fail silently. Startup must skip stale caches and rebuild them in the
// background after layout ready.
test("stale command cache is skipped at startup and rebuilt after layout ready", async ({ obsidian }) => {
    const fakeCommandId = `${targetPluginId}:fake-removed-command`;

    // 0. Pre-load the target plugin to verify it can load in this environment.
    //    If it cannot, the subsequent assertions about real commands are meaningless.
    await obsidian.evaluateApp((id) => app.plugins.enablePlugin(id), targetPluginId);
    expect((await obsidian.pluginState(targetPluginId)).loaded).toBe(true);
    await obsidian.evaluateApp((id) => app.plugins.disablePlugin(id), targetPluginId);

    // 1. Configure the target plugin as lazy so wrappers are managed for it.
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
        }, targetPluginId),
    );

    // 2. Seed a stale cache: a version that no manifest reports anymore, plus a
    //    command ID the current plugin version does not register.
    await obsidian.page.evaluate(
        ({ pluginId, fakeId }) => {
            const appWithId = app as unknown as { appId?: string };
            const appId = appWithId.appId;
            window.localStorage.setItem(`on-demand:commandCache:${appId}`, JSON.stringify({ [pluginId]: [{ id: fakeId, name: "Fake removed command" }] }));
            window.localStorage.setItem(`on-demand:commandCacheVersions:${appId}`, JSON.stringify({ [pluginId]: "0.0.0-stale" }));
        },
        { pluginId: targetPluginId, fakeId: fakeCommandId },
    );

    // 3. Reload the on-demand plugin so its startup path runs against the stale cache.
    await obsidian.reloadPlugin(pluginUnderTestId);

    // reloadPlugin refreshes the handle to the new plugin instance.
    const reloadedHandle = await obsidian.plugin(pluginUnderTestId);

    // Introspects the lazy engine so CI failures show which stage broke:
    // stale detection (staleIds/cacheValid) vs the background refresh (targetLoaded).
    const captureDebugState = () =>
        reloadedHandle.evaluate((plugin, pluginId) => {
            const features = (plugin.features as unknown as { features: Array<Record<string, unknown>> }).features;
            const lazyEngine = features.find((feature) => "commandCache" in feature) as
                | {
                      commandCache?: {
                          isCommandCacheValid(id: string): boolean;
                          getStaleCachedPluginIds(): string[];
                      };
                  }
                | undefined;
            const cache = lazyEngine?.commandCache;
            const loadedPlugins = app.plugins.plugins as Record<string, { _loaded?: boolean } | undefined>;
            return {
                layoutReady: app.workspace.layoutReady,
                manifestCount: (plugin.manifests as unknown[]).length,
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
                cacheValid: cache?.isCommandCacheValid(pluginId) ?? null,
                staleIds: cache?.getStaleCachedPluginIds() ?? null,
                targetEnabled: app.plugins.enabledPlugins.has(pluginId),
                targetLoaded: Boolean(loadedPlugins[pluginId]?._loaded),
            };
        }, targetPluginId);

    console.log("[stale-cache-debug] after reload:", JSON.stringify(await captureDebugState()));

    // 4. The stale wrapper must not be registered at startup.
    expect(await obsidian.hasCommand(fakeCommandId)).toBe(false);

    // 5. The background refresh (layout is already ready, so it runs immediately)
    //    rebuilds the cache against the currently installed version.
    const manifestVersion = await obsidian.page.evaluate((id) => app.plugins.manifests?.[id]?.version ?? null, targetPluginId);
    expect(manifestVersion).toBeTruthy();

    try {
        await expect.poll(() => readOnDemandStorageValue(obsidian, "commandCacheVersions", targetPluginId), { timeout: 15_000 }).toBe(manifestVersion);
    } finally {
        console.log("[stale-cache-debug] after refresh:", JSON.stringify(await captureDebugState()));
    }

    // 6. The fake ID stays gone, fresh wrappers exist for the real commands, and the
    //    plugin is back to disabled so lazy loading is preserved.
    expect(await obsidian.hasCommand(fakeCommandId)).toBe(false);

    expect(await obsidian.findCommands(`${targetPluginId}:`)).not.toHaveLength(0);
    // The plugin stays enabled on disk, so verify the runtime load flag.
    await obsidian.waitForPluginUnloaded(targetPluginId);
});
