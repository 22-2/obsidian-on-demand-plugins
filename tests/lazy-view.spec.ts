import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    pluginUnderTestId,
    targetPluginId,
    triggerActiveLeafChange,
    useOnDemandPlugins,
    waitForPluginEnabled
} from "./test-utils";

useOnDemandPlugins();

test("lazy mode with useView loads plugin on view activation", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            plugin.settings.lazyOnViews[pluginId] = ["markdown"];
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }

        return {
            mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null,
        };
    }, targetPluginId);

    expect(result.mode).toBe("lazy");

    await triggerActiveLeafChange(obsidian);

    const enabled = await waitForPluginEnabled(obsidian, targetPluginId);

    expect(enabled).toBe(true);
});
