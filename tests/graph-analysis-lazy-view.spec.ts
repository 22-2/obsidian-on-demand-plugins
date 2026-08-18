import { expect, test } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { ensureBuilt, pluginUnderTestId, useOnDemandPluginsWithTargets, waitForPluginEnabled } from "./test-utils";

/**
 * Regression tests for plugins that register their views AFTER an await in
 * async onload (graph-analysis-ex awaits loadSettings, then registers views
 * inside an onLayoutReady callback). loadingPluginId-based tracking cannot
 * attribute those registerView calls, so attribution happens via the
 * session-wide Plugin.prototype.registerView patch instead.
 */

// Folder name in myfiles/ is "graph-analysis"; the manifest id is "graph-analysis-ex".
const graphAnalysisId = "graph-analysis-ex";
const graphAnalysisViewType = "graph-analysis-ex";

useOnDemandPluginsWithTargets("graph-analysis");

test("apply collects view types from a plugin that registers views after async onload", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true; // prevent real reload

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: [], // intentionally empty — must be auto-populated
                useFile: false,
                fileCriteria: {},
            };
            await plugin.saveSettings();

            // Ensure the plugin starts disabled so apply goes through the enable path
            if (app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.disablePlugin(pluginId);
            }

            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return {
                mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
                viewTypes: plugin.settings?.plugins?.[pluginId]?.lazyOptions?.viewTypes ?? null,
                lazyOnViews: plugin.settings?.lazyOnViews?.[pluginId] ?? null,
            };
        } finally {
            app.commands.executeCommandById = original;
        }
    }, graphAnalysisId);

    expect(result.mode).toBe("lazy");
    expect(result.viewTypes).toContain(graphAnalysisViewType);
    expect(result.lazyOnViews).toContain(graphAnalysisViewType);
});

test("apply collects view types even when the plugin is already enabled", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: [],
                useFile: false,
                fileCriteria: {},
            };
            await plugin.saveSettings();

            // Reproduce the user-reported state: the plugin is already running
            // (e.g. after "Reload this plugin cache"), so a naive apply would
            // skip it as alreadyReady and never observe its registerView calls.
            if (!app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.enablePlugin(pluginId);
            }
            // Wipe anything the registerView patch captured during that enable,
            // so the apply itself must re-capture via the disable→enable path.
            plugin.settings.plugins[pluginId].lazyOptions.viewTypes = [];
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            delete plugin.settings.lazyOnViews[pluginId];
            await plugin.saveSettings();

            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return {
                viewTypes: plugin.settings?.plugins?.[pluginId]?.lazyOptions?.viewTypes ?? null,
            };
        } finally {
            app.commands.executeCommandById = original;
        }
    }, graphAnalysisId);

    expect(result.viewTypes).toContain(graphAnalysisViewType);
});

test("opening the graph-analysis view lazily loads the plugin", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            // Simulate the post-capture state: view types already collected
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["graph-analysis-ex"],
                useFile: false,
                fileCriteria: {},
            };
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            plugin.settings.lazyOnViews[pluginId] = ["graph-analysis-ex"];
            await plugin.saveSettings();

            if (app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.disablePlugin(pluginId);
            }
        } finally {
            app.commands.executeCommandById = original;
        }
    }, graphAnalysisId);

    // Open a leaf with the plugin's view type; the setViewState patch should
    // trigger lazy loading even though the view type is not registered yet.
    await obsidian.page.evaluate(async (viewType) => {
        const leaf = app.workspace.getLeaf(true);
        await leaf.setViewState({ type: viewType, active: true });
    }, graphAnalysisViewType);

    const enabled = await waitForPluginEnabled(obsidian, graphAnalysisId);
    expect(enabled).toBe(true);
});
