import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, useOnDemandPluginsWithTargets } from "./test-utils";

useOnDemandPluginsWithTargets("lineage", { enableBrowserConsoleLogging: false });

test("lineage not loaded when lazy-with-file-only and no matching files", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin("on-demand-plugins");

    await pluginHandle.evaluate(async (plugin) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true; // prevent reload

        try {
            plugin.settings.plugins = plugin.settings.plugins || {};
            plugin.settings.plugins["lineage"] = {
                mode: "lazy",
                userConfigured: true,
                lazyOptions: {
                    useView: false,
                    viewTypes: [],
                    useFile: true,
                    fileCriteria: { suffixes: ["ginko"] },
                },
            };

            // Apply the mode change so the loaded fixture is unloaded before rebuilding.
            await plugin.updatePluginSettings("lineage", "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    });

    const loaded = await obsidian.isPluginLoaded("lineage");
    expect(loaded).toBe(false);
});
