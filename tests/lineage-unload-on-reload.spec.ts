import { test, expect } from "obsidian-e2e-toolkit";
import path from "node:path";
import { repoRoot, ensureBuilt } from "./test-utils";

test.use({
    vaultOptions: {
        logLevel: "info",
        fresh: true,
        plugins: [
            { path: repoRoot },
            { path: path.resolve(repoRoot, "myfiles", "lineage") },
        ],
    },
});

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
    await pluginHandle.evaluate(async (plugin) => {
        // Do not stub app.commands.executeCommandById — allow reload
        await plugin.rebuildAndApplyCommandCache({ force: true });
    });

    // The page may have reloaded; wait for Obsidian to be ready again
    await obsidian.waitReady();

    // Confirm that `lineage` is NOT enabled after reload
    const enabled = await obsidian.isPluginEnabled("lineage");
    expect(enabled).toBe(false);
});
