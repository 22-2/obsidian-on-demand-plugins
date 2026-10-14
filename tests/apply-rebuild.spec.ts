import { expect, test } from "./fixtures";
import OnDemandPlugin from "src/main";
import { pluginUnderTestId, readOnDemandStorageValue, targetPluginId, triggerActiveLeafChange, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

test("apply changes updates startup policy", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            const beforeUpdatedAt = plugin.data?.commandCacheUpdatedAt ?? null;

            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return {
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
                enabled: app.plugins.enabledPlugins.has(pluginId),
            };
        }, targetPluginId),
    );

    expect(result.mode).toBe("lazy");
    expect(result.enabled).toBe(false);
});

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

test("lazy mode with useView loads plugin on view activation", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            plugin.settings.lazyOnViews[pluginId] = ["markdown"];
            await plugin.saveSettings();

            return {
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
            };
        }, targetPluginId),
    );

    expect(result.mode).toBe("lazy");

    expect(await obsidian.isPluginLoaded(targetPluginId)).toBe(false);
    await obsidian.createNote("lazy-view-trigger.md", "");
    await obsidian.open("lazy-view-trigger.md");
    await triggerActiveLeafChange(obsidian);

    await obsidian.waitForPluginLoaded(targetPluginId);
});

test("enabling disabled plugin syncs settings to keepEnabled", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Set the target plugin to disabled
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "alwaysDisabled");
        }, targetPluginId),
    );

    // 2. Enable the way the Community plugins toggle and the CLI do (triggers the patch).
    // A plain enablePlugin call is a runtime load, which must leave the saved mode alone.
    await obsidian.page.evaluate((id) => app.plugins.enablePluginAndSave(id), targetPluginId);

    // Wait for enable to complete
    await obsidian.waitForPluginLoaded(targetPluginId);

    // 3. Verify settings synced to "keepEnabled"
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        return {
            mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
            userConfigured: plugin.settings?.plugins?.[pluginId]?.userConfigured ?? false,
        };
    }, targetPluginId);

    expect(result.mode).toBe("alwaysEnabled");
    expect(result.userConfigured).toBe(true);
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

test("apply changes writes community-plugins.json", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            // prevent real reload

            // Make plugin keepEnabled so it should be present in the file
            await plugin.updatePluginSettings(pluginId, "alwaysEnabled");
            await plugin.applyStartupPolicyAndRestart([pluginId]);
        }, targetPluginId),
    );

    const parsed = await obsidian.enabledPluginsOnDisk();

    // Should include the on-demand plugin and the kept plugin
    expect(parsed).toContain(pluginUnderTestId);
    expect(parsed).toContain(targetPluginId);
});

test("Apply changes records an empty view snapshot for a plugin without views", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const detected = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            // prevent reload

            // Ensure no pre-existing entry
            if (plugin.settings.lazyOnViews && plugin.settings.lazyOnViews[pluginId]) {
                delete plugin.settings.lazyOnViews[pluginId];
                await plugin.saveSettings();
            }

            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: [],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return plugin.settings.lazyOnViews?.[pluginId] ?? null;
        }, targetPluginId),
    );

    // BRAT has commands but no views. An empty snapshot must complete without a timeout.
    expect(detected).toEqual([]);
});
