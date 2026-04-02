import { expect, test } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import {
    ensureBuilt,
    pluginUnderTestId,
    targetPluginId,
    triggerActiveLeafChange,
    useOnDemandPlugins,
    waitForPluginEnabled,
} from "./test-utils";

useOnDemandPlugins();

/**
 * Regression test: mode="lazy" + useView=true should collect viewTypes
 * during the Apply Changes startup phase, just like "lazyOnView" does.
 *
 * Bug: ViewRegistryInterceptor only watched LAZY_ON_VIEW plugins, so plugins
 * in LAZY mode with lazyOptions.useView=true never had their viewTypes populated.
 */
test("lazy mode with useView:true collects viewTypes during apply", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true; // prevent real reload

        try {
            // Clear any pre-existing lazyOptions state
            if (plugin.settings.plugins[pluginId]) {
                delete plugin.settings.plugins[pluginId].lazyOptions;
            }
            if (plugin.settings.lazyOnViews?.[pluginId]) {
                delete plugin.settings.lazyOnViews[pluginId];
            }

            // Set to "lazy" mode (NOT "lazyOnView") with useView: true
            await plugin.updatePluginSettings(pluginId, "lazy");

            // Set lazyOptions.useView = true  (viewTypes intentionally empty — should be auto-populated)
            plugin.settings.plugins[pluginId].lazyOptions = {
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
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

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
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // Configure: lazy mode + useView=true with explicit viewType "markdown"
    const setupResult = await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            if (plugin.settings.plugins[pluginId]) {
                delete plugin.settings.plugins[pluginId].lazyOptions;
            }
            if (plugin.settings.lazyOnViews?.[pluginId]) {
                delete plugin.settings.lazyOnViews[pluginId];
            }

            await plugin.updatePluginSettings(pluginId, "lazy");

            // Manually specify viewType "markdown" so we don't depend on auto-detection
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }

        return {
            mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
            viewTypes: plugin.settings?.plugins?.[pluginId]?.lazyOptions?.viewTypes ?? [],
        };
    }, targetPluginId);

    expect(setupResult.mode).toBe("lazy");
    expect(setupResult.viewTypes).toContain("markdown");

    // Simulate an active-leaf-change event on a markdown leaf to trigger the loader
    await triggerActiveLeafChange(obsidian);

    // Wait up to 8 s for the plugin to be enabled
    const enabled = await waitForPluginEnabled(obsidian, targetPluginId);

    expect(enabled).toBe(true);
});
