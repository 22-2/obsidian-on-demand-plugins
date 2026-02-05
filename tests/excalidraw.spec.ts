import { test, expect } from "obsidian-e2e-toolkit";
import {
    repoRoot,
    pluginUnderTestId,
    excalidrawPluginId,
    ensureBuilt,
    useOnDemandPluginsWithExcalidraw,
} from "./test-utils";

useOnDemandPluginsWithExcalidraw();

test("opening .excalidraw.md triggers lazy load and shows Excalidraw view", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // configure lazyOnView for Excalidraw
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;
        try {
            await plugin.updatePluginSettings(pluginId, "lazyOnView");
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            plugin.settings.lazyOnViews[pluginId] = [];
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }
        return { mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null };
    }, excalidrawPluginId);

    expect(result.mode).toBe("lazyOnView");

    // create an Excalidraw markdown file and open it
    await obsidian.page.evaluate(() => {
        return app.vault.create("test.excalidraw.md", "---\nexcalidraw-plugin: parsed\n---\n");
    });

    await obsidian.page.evaluate(() => {
        const f = app.vault.getAbstractFileByPath("test.excalidraw.md");
        const leaf = app.workspace.getLeaf(false);
        if (f && leaf) leaf.openFile(f as any);
    });

    // wait for plugin to be enabled
    const deadline = Date.now() + 10000;
    let enabled = false;
    while (Date.now() < deadline) {
        if (await obsidian.isPluginEnabled(excalidrawPluginId)) {
            enabled = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 300));
    }

    expect(enabled).toBe(true);

    // assert an excalidraw view exists
    const hasView = await obsidian.page.evaluate(() => {
        return app.workspace.getLeavesOfType("excalidraw").length > 0;
    });

    expect(hasView).toBe(true);
});

test("layout-restore triggers lazy load for already-open Excalidraw file", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // configure lazyOnView for Excalidraw
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;
        try {
            await plugin.updatePluginSettings(pluginId, "lazyOnView");
            plugin.settings.lazyOnViews = plugin.settings.lazyOnViews || {};
            plugin.settings.lazyOnViews[pluginId] = [];
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }
    }, excalidrawPluginId);

    // create file and open it (will open as markdown initially)
    await obsidian.page.evaluate(() => {
        return app.vault.create("test2.excalidraw.md", "---\nexcalidraw-plugin: parsed\n---\n");
    });

    await obsidian.page.evaluate(() => {
        const f = app.vault.getAbstractFileByPath("test2.excalidraw.md");
        const leaf = app.workspace.getLeaf(false);
        if (f && leaf) leaf.openFile(f as any);
    });

    // simulate layout restore event
    await obsidian.page.evaluate(() => {
        const workspace = app.workspace as any;
        workspace.trigger && workspace.trigger("layout-ready");
    });

    const deadline2 = Date.now() + 10000;
    let enabled2 = false;
    while (Date.now() < deadline2) {
        if (await obsidian.isPluginEnabled(excalidrawPluginId)) {
            enabled2 = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 300));
    }

    expect(enabled2).toBe(true);

    const hasView2 = await obsidian.page.evaluate(() => {
        return app.workspace.getLeavesOfType("excalidraw").length > 0;
    });

    expect(hasView2).toBe(true);
});
