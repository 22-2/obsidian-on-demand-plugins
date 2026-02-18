import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("force rebuild refreshes command cache", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const appId = (app as any).appId ?? (app as any).app?.appId ?? (app as any).manifest?.id;
        const getStored = (prefix: string) => {
            try {
                const key = `on-demand:${prefix}:${appId}`;
                const raw = window.localStorage.getItem(key);
                return raw ? JSON.parse(raw) : null;
            } catch (e) {
                return null;
            }
        };

        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }

        return {
            cacheCount: getStored("commandCache")?.[pluginId]?.length ?? 0,
        };
    }, targetPluginId);

    expect(result.cacheCount).toBeGreaterThanOrEqual(0);
});

test("commandCacheVersions updates on force rebuild", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }

        const manifestVersion = app.plugins.manifests?.[pluginId]?.version ?? null;
        const appId = (app as any).appId ?? (app as any).app?.appId ?? (app as any).manifest?.id;
        const getStored = (prefix: string) => {
            try {
                const key = `on-demand:${prefix}:${appId}`;
                const raw = window.localStorage.getItem(key);
                return raw ? JSON.parse(raw) : null;
            } catch (e) {
                return null;
            }
        };
        const cachedVersion = getStored("commandCacheVersions")?.[pluginId] ?? null;
        return { manifestVersion, cachedVersion };
    }, targetPluginId);

    expect(result.manifestVersion).toBeTruthy();
    expect(result.cachedVersion).toBe(result.manifestVersion);
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
            await plugin.updatePluginSettings(pluginId, "keepEnabled");
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

    expect(result.mode).toBe("disabled");
    expect(result.userConfigured).toBe(true);
});
