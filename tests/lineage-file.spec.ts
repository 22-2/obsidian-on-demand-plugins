import { expect, test } from "./fixtures";
import { useOnDemandPluginsWithTargets, withReloadRecorded } from "./test-utils";

useOnDemandPluginsWithTargets("lineage", { enableBrowserConsoleLogging: false });

test("lineage not loaded when lazy-with-file-only and no matching files", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin("on-demand-plugins");

    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin) => {
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
        }),
    );

    const loaded = await obsidian.isPluginLoaded("lineage");
    expect(loaded).toBe(false);
});
