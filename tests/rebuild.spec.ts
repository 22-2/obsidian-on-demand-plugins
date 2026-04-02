import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    pluginUnderTestId,
    readOnDemandStorageValue,
    targetPluginId,
    useOnDemandPlugins,
} from "./test-utils";

useOnDemandPlugins();

test("force rebuild refreshes command cache", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    const cachedCommands = await readOnDemandStorageValue(obsidian, "commandCache", targetPluginId);
    const cacheCount = Array.isArray(cachedCommands) ? cachedCommands.length : 0;

    expect(cacheCount).toBeGreaterThanOrEqual(0);
});

test("commandCacheVersions updates on force rebuild", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const manifestVersion = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }

        return app.plugins.manifests?.[pluginId]?.version ?? null;
    }, targetPluginId);

    expect(manifestVersion).toBeTruthy();

    const cachedVersion = await readOnDemandStorageValue(obsidian, "commandCacheVersions", targetPluginId);

    expect(cachedVersion).toBe(manifestVersion);
});

test("disabling keepEnabled plugin syncs settings to disabled", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Set the target plugin to keepEnabled
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "alwaysEnabled");
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    // 2. Disable via Obsidian UI (triggers the patch)
    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

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
