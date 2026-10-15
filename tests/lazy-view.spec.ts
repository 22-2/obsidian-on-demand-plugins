import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, triggerActiveLeafChange, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

test("lazy mode with useView loads plugin on view activation", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            plugin.core.settingsService.activeProfile.settings.lazyOnViews = plugin.core.settingsService.activeProfile.settings.lazyOnViews || {};
            plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId] = ["markdown"];
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
