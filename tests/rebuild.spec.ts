import { expect, test } from "./fixtures";
import { pluginUnderTestId, readOnDemandStorageValue, targetPluginId, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

test("force rebuild refreshes command cache", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        }, targetPluginId),
    );

    const cachedCommands = await readOnDemandStorageValue(obsidian, "commandCache", targetPluginId);
    const cacheCount = Array.isArray(cachedCommands) ? cachedCommands.length : 0;

    expect(cacheCount).toBeGreaterThan(0);
});

test("commandCacheVersions updates on force rebuild", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const manifestVersion = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });

            return app.plugins.manifests?.[pluginId]?.version ?? null;
        }, targetPluginId),
    );

    expect(manifestVersion).toBeTruthy();

    const cachedVersion = await readOnDemandStorageValue(obsidian, "commandCacheVersions", targetPluginId);

    expect(cachedVersion).toBe(manifestVersion);
});

test("disabling keepEnabled plugin syncs settings to disabled", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Set the target plugin to keepEnabled
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "alwaysEnabled");
        }, targetPluginId),
    );

    // 2. Disable the way the Community plugins toggle and the CLI do (triggers the patch).
    // A plain disablePlugin call is a runtime unload, which must leave the saved mode alone.
    await obsidian.page.evaluate((id) => app.plugins.disablePluginAndSave(id), targetPluginId);

    // 3. Verify settings synced to "disabled"
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        return {
            mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
            userConfigured: plugin.settings?.plugins?.[pluginId]?.userConfigured ?? false,
        };
    }, targetPluginId);

    expect(result.mode).toBe("alwaysDisabled");
    expect(result.userConfigured).toBe(true);
});
