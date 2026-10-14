import { expect, test } from "./fixtures";
import { pluginUnderTestId, useOnDemandPluginsWithTargets, withReloadRecorded } from "./test-utils";

const targetPluginId = "obsidian-another-quick-switcher";

useOnDemandPluginsWithTargets(targetPluginId);

test("Another Quick Switcher: should NOT be loaded at startup when set to lazy", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Set to lazy mode and apply (writes community-plugins.json)
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.applyStartupPolicyAndRestart([pluginId]);
        }, targetPluginId),
    );

    // 2. Restart Obsidian to check startup state
    await obsidian.reload();

    // 3. Verify it is NOT enabled
    const isEnabled = await obsidian.isPluginEnabled(targetPluginId);
    console.log(`Plugin enabled state: ${isEnabled}`);

    // Check community-plugins.json
    const communityPlugins = await obsidian.enabledPluginsOnDisk();
    console.log(`community-plugins.json: ${JSON.stringify(communityPlugins)}`);
    expect(communityPlugins).not.toContain(targetPluginId);

    expect(isEnabled).toBe(false);

    // 4. Double check by looking at app.plugins.plugins
    const isInitialized = await obsidian.page.evaluate((id) => {
        return id in app.plugins.plugins;
    }, targetPluginId);
    console.log(`Plugin in app.plugins.plugins: ${isInitialized}`);
    expect(isInitialized).toBe(false);
});
