import { expect, test } from "./fixtures";
import { pluginUnderTestId, useOnDemandPluginsWithTargets, withReloadRecorded } from "./test-utils";

const lineagePluginId = "lineage";

useOnDemandPluginsWithTargets(lineagePluginId);

test("Lineage plugin should not be loaded at startup when configured as lazy", async ({ obsidian }) => {
    // Verify Lineage is loaded initially (since we enabled it in setup)
    const isLoadedInitially = await obsidian.page.evaluate((id) => {
        return !!app.plugins.plugins[id];
    }, lineagePluginId);
    expect(isLoadedInitially).toBe(true);

    // Get handle to our plugin
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // Configure Lineage as lazy and rebuild command cache. The reload is recorded, not performed.
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            // Set mode to lazy
            await plugin.updatePluginSettings(pluginId, "lazy");

            // Force rebuild command cache (this should disable the plugin)
            await plugin.rebuildAndApplyCommandCache({ force: true });
        }, lineagePluginId),
    );

    // Verify Lineage is disabled after rebuild
    const isLoadedAfterRebuild = await obsidian.page.evaluate((id) => {
        console.log("Checking if loaded after rebuild:", id);
        console.log("Enabled plugins:", Array.from(app.plugins.enabledPlugins));
        console.log("Plugin instance:", app.plugins.plugins[id]);
        return !!app.plugins.plugins[id];
    }, lineagePluginId);

    expect(isLoadedAfterRebuild).toBe(false);

    // Check community-plugins.json content
    const enabledPlugins = await obsidian.enabledPluginsOnDisk();
    expect(enabledPlugins).not.toContain(lineagePluginId);
});
