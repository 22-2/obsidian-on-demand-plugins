import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, useOnDemandPluginsWithTargets } from "./test-utils";

useOnDemandPluginsWithTargets("lineage", { enableBrowserConsoleLogging: false });

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

    // Capture enabledPlugins at the moment reload is requested, then swallow the
    // reload itself: letting it navigate would destroy the evaluate() context
    // below before its promise settles, and only the snapshot matters here.
    await obsidian.evaluateApp(() => {
        const original = app.commands.executeCommandById.bind(app.commands);
        app.commands.executeCommandById = (id: string) => {
            if (id !== "app:reload") return original(id);
            const arr = [...(app.plugins.enabledPlugins || new Set())];
            window.localStorage.setItem("on-demand:test:enabledSnapshot", JSON.stringify(arr));
            return true;
        };
    });

    await pluginHandle.evaluate(async (plugin) => {
        await plugin.rebuildAndApplyCommandCache({ force: true });
    });

    const raw = await obsidian.page.evaluate(() => window.localStorage.getItem("on-demand:test:enabledSnapshot"));
    expect(raw).toBeTruthy();
    const snapshot: string[] = raw ? JSON.parse(raw) : [];

    // lineage should NOT be present in the enabled plugins set at reload time
    expect(snapshot.includes("lineage")).toBe(false);
});
