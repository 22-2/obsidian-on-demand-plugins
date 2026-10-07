import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, useOnDemandPluginsWithTargets } from "./test-utils";

useOnDemandPluginsWithTargets("lineage", { enableBrowserConsoleLogging: false });

test("lineage remains unloaded after location.reload during apply", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin("on-demand-plugins");

    // Configure lineage to be lazy + file-based (no view types)
    await pluginHandle.evaluate(async (plugin) => {
        plugin.settings.plugins = plugin.settings.plugins || {};
        plugin.settings.plugins["lineage"] = {
            mode: "lazy",
            userConfigured: true,
            lazyOptions: {
                useView: true,
                viewTypes: [],
                useFile: true,
                fileCriteria: { suffixes: ["ginko"] },
            },
        };
        await plugin.saveSettings();
    });

    // Trigger rebuild+apply which will call reload; allow the reload to happen
    // so we can validate the persisted community-plugins.json is correct.
    // The reload can navigate before evaluate() settles, which destroys its
    // execution context; that is the expected outcome here, not a failure.
    try {
        await pluginHandle.evaluate(async (plugin) => {
            // Do not stub app.commands.executeCommandById — allow reload
            await plugin.rebuildAndApplyCommandCache({ force: true });
        });
    } catch (error) {
        if (!String(error).includes("Execution context was destroyed")) throw error;
    }

    // The page may have reloaded; wait for Obsidian to be ready again
    await obsidian.waitReady();

    // Confirm that `lineage` is NOT enabled after reload
    const enabled = await obsidian.isPluginEnabled("lineage");
    expect(enabled).toBe(false);
});
