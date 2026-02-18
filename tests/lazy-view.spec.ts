import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("lazyOnView loads plugin on view activation", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazyOnView");
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

    expect(result.mode).toBe("lazyOnView");

    await obsidian.page.evaluate(() => {
        const workspace = app.workspace as unknown as {
            getActiveLeaf?: () => unknown;
            activeLeaf?: unknown;
            trigger: (event: string, leaf: unknown) => void;
        };
        const leaf = workspace.getActiveLeaf?.() ?? workspace.activeLeaf ?? null;
        workspace.trigger("active-leaf-change", leaf);
    });

    const deadline = Date.now() + 8000;
    let enabled = false;
    while (Date.now() < deadline) {
        if (await obsidian.isPluginEnabled(targetPluginId)) {
            enabled = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 300));
    }

    expect(enabled).toBe(true);
});
