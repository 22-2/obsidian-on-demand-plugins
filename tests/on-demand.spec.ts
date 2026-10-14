import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("on-demand: lazy command enables plugin", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    const mode = await pluginHandle.evaluate((plugin, pluginId) => {
        return plugin.settings?.plugins?.[pluginId]?.mode;
    }, targetPluginId);
    expect(mode).toBe("lazy");

    // Attempt to disable for a stronger signal (may be overridden by Obsidian state)
    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

    const [commandId] = await obsidian.findCommands(`${targetPluginId}:`);

    expect(commandId).toBeTruthy();
    await obsidian.command(commandId);

    await obsidian.waitForPluginLoaded(targetPluginId);
});
