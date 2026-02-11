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

test("capture enabled plugins snapshot before reload (lineage should be unloaded)", async ({ obsidian }) => {
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

    // Install a reload interceptor that saves enabledPlugins to localStorage
    await obsidian.page.evaluate(() => {
        // @ts-ignore
        const original = app.commands.executeCommandById.bind(app.commands);
        (app as any).__onDemand_reload_original = original;
        app.commands.executeCommandById = (id: string) => {
            if (id === "app:reload") {
                try {
                    const arr = [...(app.plugins.enabledPlugins || new Set())];
                    window.localStorage.setItem("on-demand:test:enabledSnapshot", JSON.stringify(arr));
                } catch (e) {
                    // ignore
                }
            }
            return original(id);
        };
    });

    // Trigger rebuild+apply which will call reload and our interceptor will save snapshot
    await pluginHandle.evaluate(async (plugin) => {
        await plugin.rebuildAndApplyCommandCache({ force: true });
    });

    // Wait for reload + ready
    await obsidian.waitReady();

    const raw = await obsidian.page.evaluate(() => window.localStorage.getItem("on-demand:test:enabledSnapshot"));
    expect(raw).toBeTruthy();
    const snapshot: string[] = raw ? JSON.parse(raw) : [];

    // lineage should NOT be present in the enabled plugins set at reload time
    expect(snapshot.includes("lineage")).toBe(false);
});
