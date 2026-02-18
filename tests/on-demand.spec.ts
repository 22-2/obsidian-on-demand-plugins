import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("on-demand: lazy command enables plugin", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

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

    const commandId = await obsidian.page.evaluate((id) => {
        return Object.keys(app.commands.commands).find((cmd) =>
            cmd.startsWith(`${id}:`),
        );
    }, targetPluginId);

    expect(commandId).toBeTruthy();
    await obsidian.command(commandId as string);

    expect(await obsidian.isPluginEnabled(targetPluginId)).toBe(true);
});
