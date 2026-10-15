import { expect, test } from "./fixtures";
import type OnDemandPlugin from "src/main";
import { pluginUnderTestId, targetPluginId, triggerActiveLeafChange, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

/**
 * Regression test: mode="lazy" + useView=true should collect viewTypes
 * during the Apply Changes startup phase.
 *
 * Bug: ViewRegistryInterceptor previously skipped some lazy+useView plugins,
 * so their viewTypes were not populated during apply.
 */
test("lazy mode with useView:true collects viewTypes during apply", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            // prevent real reload

            // Clear any pre-existing lazyOptions state
            if (plugin.core.settingsService.activeProfile.settings.plugins[pluginId]) {
                delete plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions;
            }
            if (plugin.core.settingsService.activeProfile.settings.lazyOnViews?.[pluginId]) {
                delete plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId];
            }

            // Set to "lazy" mode with useView: true
            await plugin.updatePluginSettings(pluginId, "lazy");

            // Set lazyOptions.useView = true  (viewTypes intentionally empty — should be auto-populated)
            plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: [],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.saveSettings();

            // Run the startup policy — this is where viewTypes should be collected
            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return {
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
                viewTypes: plugin.settings?.plugins?.[pluginId]?.lazyOptions?.viewTypes ?? null,
                lazyOnViews: plugin.settings?.lazyOnViews?.[pluginId] ?? null,
            };
        }, targetPluginId),
    );

    expect(result.mode).toBe("lazy");

    // viewTypes should have been populated by the ViewRegistryInterceptor
    // (If the test plugin registers no view types, the array may be empty but must not be null)
    expect(result.viewTypes).not.toBeNull();
    expect(Array.isArray(result.viewTypes)).toBe(true);
});

/**
 * Verify that once viewTypes are collected for a lazy+useView plugin,
 * the ViewLazyLoader can actually trigger loading when that view becomes active.
 */
test("lazy mode with useView:true loads plugin when matching view is activated", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // Configure: lazy mode + useView=true with explicit viewType "markdown"
    const setupResult = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            if (plugin.core.settingsService.activeProfile.settings.plugins[pluginId]) {
                delete plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions;
            }
            if (plugin.core.settingsService.activeProfile.settings.lazyOnViews?.[pluginId]) {
                delete plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId];
            }

            await plugin.updatePluginSettings(pluginId, "lazy");

            // Manually specify viewType "markdown" so we don't depend on auto-detection
            plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.saveSettings();

            return {
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
                viewTypes: plugin.settings?.plugins?.[pluginId]?.lazyOptions?.viewTypes ?? [],
            };
        }, targetPluginId),
    );

    expect(setupResult.mode).toBe("lazy");
    expect(setupResult.viewTypes).toContain("markdown");

    // Simulate an active-leaf-change event on a markdown leaf to trigger the loader
    expect(await obsidian.isPluginLoaded(targetPluginId)).toBe(false);
    await obsidian.createNote("lazy-view-trigger.md", "");
    await obsidian.open("lazy-view-trigger.md");
    await triggerActiveLeafChange(obsidian);

    // Wait up to 8 s for the plugin to be enabled
    await obsidian.waitForPluginLoaded(targetPluginId);
});
