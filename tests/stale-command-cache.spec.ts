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

    // 4. The stale wrapper must not be registered at startup.
    expect(await findCommandByExactId(obsidian, fakeCommandId)).toBeNull();

    // 5. The background refresh (layout is already ready, so it runs immediately)
    //    rebuilds the cache against the currently installed version.
    const manifestVersion = await obsidian.page.evaluate((id) => app.plugins.manifests?.[id]?.version ?? null, targetPluginId);
    expect(manifestVersion).toBeTruthy();

    await expect
        .poll(async () => readOnDemandStorageValue(obsidian, "commandCacheVersions", targetPluginId), {
            timeout: 15_000,
        })
        .toBe(manifestVersion);

    // 6. The fake ID stays gone, fresh wrappers exist for the real commands, and the
    //    plugin is back to disabled so lazy loading is preserved.
    expect(await findCommandByExactId(obsidian, fakeCommandId)).toBeNull();
    expect(await findCommandByPrefix(obsidian, `${targetPluginId}:`)).not.toBeNull();
    expect(await waitForPluginDisabled(obsidian, targetPluginId)).toBe(true);
});
