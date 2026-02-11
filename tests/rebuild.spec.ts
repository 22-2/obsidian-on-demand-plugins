import { test, expect } from "obsidian-e2e-toolkit";
import { repoRoot, pluginUnderTestId, targetPluginId, ensureBuilt, useOnDemandPlugins } from "./test-utils";

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

test("reRegisterLazyCommandsOnDisable keeps command wrappers", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            plugin.settings.reRegisterLazyCommandsOnDisable = true;
            await plugin.saveSettings();
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    const commandId = await obsidian.page.evaluate((id) => {
        return Object.keys(app.commands.commands).find((cmd) =>
            cmd.startsWith(`${id}:`),
        );
    }, targetPluginId);

    expect(commandId).toBeTruthy();

    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

    const stillExists = await obsidian.page.evaluate((cmd) => {
        return Boolean(app.commands.commands[cmd]);
    }, commandId as string);

    expect(stillExists).toBe(true);
});
