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
                    useView: true,
                    viewTypes: [],
                    useFile: true,
                    fileCriteria: { suffixes: ["ginko"] },
                },
            };

            await plugin.saveSettings();
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    });

    const enabled = await obsidian.isPluginEnabled("lineage");
    expect(enabled).toBe(false);
});
