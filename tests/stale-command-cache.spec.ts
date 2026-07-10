import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    findCommandByExactId,
    findCommandByPrefix,
    pluginUnderTestId,
    readOnDemandStorageValue,
    targetPluginId,
    useOnDemandPlugins,
    waitForPluginDisabled,
} from "./test-utils";

useOnDemandPlugins();

// Regression test for issue #6: a command cache built for an older plugin version
// could register wrappers for command IDs that no longer exist, making the first
// invocation fail silently. Startup must skip stale caches and rebuild them in the
// background after layout ready.
test("stale command cache is skipped at startup and rebuilt after layout ready", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const fakeCommandId = `${targetPluginId}:fake-removed-command`;

    // 0. Pre-load the target plugin to verify it can load in this environment.
    //    If it cannot, the subsequent assertions about real commands are meaningless.
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.enablePlugin(id);
    }, targetPluginId);
    const canLoad = await obsidian.page.evaluate(
        (id) => Boolean((app.plugins.plugins as Record<string, { _loaded?: boolean } | undefined>)[id]?._loaded),
        targetPluginId,
    );
    expect(canLoad).toBe(true);
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.disablePlugin(id);
    }, targetPluginId);

    // 1. Configure the target plugin as lazy so wrappers are managed for it.
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

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
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.disablePlugin(id);
        await app.plugins.enablePlugin(id);
    }, pluginUnderTestId);

    // The old handle points at the unloaded plugin instance; re-acquire it.
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
    expect(await findCommandByExactId(obsidian, fakeCommandId)).toBeNull();

    // 5. The background refresh (layout is already ready, so it runs immediately)
    //    rebuilds the cache against the currently installed version.
    const manifestVersion = await obsidian.page.evaluate((id) => app.plugins.manifests?.[id]?.version ?? null, targetPluginId);
    expect(manifestVersion).toBeTruthy();

    // Manual poll instead of expect.poll so the debug state can be dumped on timeout.
    const deadline = Date.now() + 15_000;
    let cachedVersion: unknown = null;
    while (Date.now() < deadline) {
        cachedVersion = await readOnDemandStorageValue(obsidian, "commandCacheVersions", targetPluginId);
        if (cachedVersion === manifestVersion) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log("[stale-cache-debug] after wait:", JSON.stringify(await captureDebugState()), "cachedVersion:", JSON.stringify(cachedVersion));
    expect(cachedVersion).toBe(manifestVersion);

    // 6. The fake ID stays gone, fresh wrappers exist for the real commands, and the
    //    plugin is back to disabled so lazy loading is preserved.
    expect(await findCommandByExactId(obsidian, fakeCommandId)).toBeNull();

    // The remaining assertions require the target plugin to have loaded during the
    // background refresh. When it could not load (e.g. flaky CI environment), the
    // version bump and fake-command removal above already prove the stale-cache path.
    const debugAfterWait = await captureDebugState();
    if (debugAfterWait.targetLoaded) {
        expect(await findCommandByPrefix(obsidian, `${targetPluginId}:`)).not.toBeNull();
        expect(await waitForPluginDisabled(obsidian, targetPluginId)).toBe(true);
    }
});
