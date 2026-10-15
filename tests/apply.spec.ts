import { expect, test } from "./fixtures";
import OnDemandPlugin from "src/main";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

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
            if (plugin.core.settingsService.activeProfile.settings.lazyOnViews && plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId]) {
                delete plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId];
                await plugin.saveSettings();
            }

            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: [],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return plugin.core.settingsService.activeProfile.settings.lazyOnViews?.[pluginId] ?? null;
        }, targetPluginId),
    );

    // BRAT has commands but no views. An empty snapshot must complete without a timeout.
    expect(detected).toEqual([]);
});
