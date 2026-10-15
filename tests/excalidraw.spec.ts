import { expect, test } from "./fixtures";
import { excalidrawPluginId, pluginUnderTestId, useOnDemandPluginsWithExcalidraw, withReloadRecorded } from "./test-utils";

useOnDemandPluginsWithExcalidraw();

test("opening .excalidraw.md triggers lazy load and shows Excalidraw view", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // configure lazy loading for Excalidraw
    const result = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            // plugin.core.settingsService.activeProfile.settings.lazyOnViews = plugin.core.settingsService.activeProfile.settings.lazyOnViews || {};
            // plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId] = [];
            await plugin.saveSettings();

            return { mode: plugin.settings?.plugins?.[pluginId]?.mode ?? null };
        }, excalidrawPluginId),
    );

    expect(result.mode).toBe("lazy");
    // create an Excalidraw markdown file and open it
    await obsidian.page.evaluate(async () => {
        const f = await app.vault.create("test.excalidraw.md", "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'\n\n\n## Drawing\n```compressed-json\nN4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MQHNsYfpwBGAOlT0AtmIBeNCtlQbs6RmPry6uA4wC0KDDgLFLUTJ2lH8MTDHQ0YNMWHRJMRZFFgAGRQBmMiRPVRhGMBoEAG0AXXJ0KCgAZQCwPlBJfDwc7A0+Rk5MTHIdGCIAIXRUAGtirkZcAGF6THp8BBAAYgAzcYmQAF8poA===\n```\n%%");
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(f);
    });

    // wait for plugin to be enabled
    await obsidian.waitForPluginLoaded(excalidrawPluginId, 10_000);

    // assert an excalidraw view exists (poll because view registration is async)
    await obsidian.waitForViewType("excalidraw", 10_000);
});

test("layout-restore triggers lazy load for already-open Excalidraw file", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // configure lazy loading for Excalidraw
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.core.settingsService.activeProfile.settings.lazyOnViews = plugin.core.settingsService.activeProfile.settings.lazyOnViews || {};
            plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId] = [];
            await plugin.saveSettings();
        }, excalidrawPluginId),
    );

    // create file and open it (will open as markdown initially)
    await obsidian.page.evaluate(async () => {
        const f = await app.vault.create("test.excalidraw.md", "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'\n\n\n## Drawing\n```compressed-json\nN4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MQHNsYfpwBGAOlT0AtmIBeNCtlQbs6RmPry6uA4wC0KDDgLFLUTJ2lH8MTDHQ0YNMWHRJMRZFFgAGRQBmMiRPVRhGMBoEAG0AXXJ0KCgAZQCwPlBJfDwc7A0+Rk5MTHIdGCIAIXRUAGtirkZcAGF6THp8BBAAYgAzcYmQAF8poA===\n```\n%%");
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(f);
    });

    // simulate layout restore event
    await obsidian.page.evaluate(() => {
        app.workspace.trigger("layout-ready");
    });

    await obsidian.waitForPluginLoaded(excalidrawPluginId, 10_000);

    // poll for excalidraw view (view registration is async after plugin load)
    await obsidian.waitForViewType("excalidraw", 10_000);
});
