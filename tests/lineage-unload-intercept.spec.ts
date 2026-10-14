import { expect, test } from "./fixtures";
import { useOnDemandPluginsWithTargets } from "./test-utils";

useOnDemandPluginsWithTargets("lineage", { enableBrowserConsoleLogging: false });

test("capture enabled plugins snapshot before reload (lineage should be unloaded)", async ({ obsidian }) => {
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

    // Record each app:reload request together with the plugins enabled at that moment.
    // The reload itself is swallowed: letting it navigate would destroy the evaluate() context below.
    const reloads = await obsidian.interceptReload();
    await pluginHandle.evaluate(async (plugin) => {
        await plugin.rebuildAndApplyCommandCache({ force: true });
    });
    const requests = await reloads.requests();
    await reloads.restore();

    expect(requests).not.toHaveLength(0);
    // lineage should NOT be present in the enabled plugins set at any reload request
    for (const request of requests) {
        expect(request.enabledPluginIds).not.toContain("lineage");
    }
});
