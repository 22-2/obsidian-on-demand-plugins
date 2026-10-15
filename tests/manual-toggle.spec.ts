import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, triggerActiveLeafChange, useOnDemandPlugins, withReloadRecorded } from "./test-utils";

useOnDemandPlugins();

test("in-memory plugin commands enable and disable a selected plugin", async ({ obsidian }) => {
    await obsidian.page.evaluate(async (pluginId) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as (typeof app.plugins.plugins)[string] & {
            updatePluginSettings: (id: string, mode: "lazy") => Promise<void>;
        };
        // Keep the target lazy so Obsidian's enable/disable sync patch preserves its saved policy.
        await plugin.updatePluginSettings(pluginId, "lazy");
        await app.plugins.disablePlugin(pluginId);
    }, targetPluginId);
    // This command filters by the plugin object's live load flag, which can differ from Obsidian's enabled set.
    await expect.poll(() => obsidian.page.evaluate((pluginId) => Boolean(app.plugins.plugins[pluginId]?._loaded), targetPluginId)).toBe(false);
    const enabledOnDiskBefore = await obsidian.enabledPluginsOnDisk();

    await obsidian.page.evaluate((commandId) => app.commands.executeCommandById(commandId), `${pluginUnderTestId}:enable-plugin-in-memory`);
    const enablePicker = obsidian.page.getByPlaceholder("Select a plugin to enable");
    await expect(enablePicker).toBeVisible();
    await enablePicker.fill(targetPluginId);
    const enableChoice = obsidian.page.locator(".suggestion-item").filter({ hasText: targetPluginId });
    await expect(enableChoice).toBeVisible();
    await enableChoice.click();
    await expect.poll(() => obsidian.page.evaluate((pluginId) => Boolean(app.plugins.plugins[pluginId]?._loaded), targetPluginId)).toBe(true);
    expect(await obsidian.enabledPluginsOnDisk()).toEqual(enabledOnDiskBefore);

    const modeAfterEnable = await obsidian.page.evaluate((pluginId) => (app.plugins.plugins["on-demand-plugins"] as (typeof app.plugins.plugins)[string] & { getPluginMode: (id: string) => string }).getPluginMode(pluginId), targetPluginId);
    expect(modeAfterEnable).toBe("lazy");

    await obsidian.page.evaluate((commandId) => app.commands.executeCommandById(commandId), `${pluginUnderTestId}:disable-plugin-in-memory`);
    const disablePicker = obsidian.page.getByPlaceholder("Select a plugin to disable");
    await expect(disablePicker).toBeVisible();
    await disablePicker.fill(targetPluginId);
    const disableChoice = obsidian.page.locator(".suggestion-item").filter({ hasText: targetPluginId });
    await expect(disableChoice).toBeVisible();
    await disableChoice.click();
    await expect.poll(() => obsidian.page.evaluate((pluginId) => Boolean(app.plugins.plugins[pluginId]?._loaded), targetPluginId)).toBe(false);
    expect(await obsidian.enabledPluginsOnDisk()).toEqual(enabledOnDiskBefore);

    const modeAfterDisable = await obsidian.page.evaluate((pluginId) => (app.plugins.plugins["on-demand-plugins"] as (typeof app.plugins.plugins)[string] & { getPluginMode: (id: string) => string }).getPluginMode(pluginId), targetPluginId);
    expect(modeAfterDisable).toBe("lazy");
});

test("manual enable/disable is stable for lazy (command)", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // Configure plugin as lazy and build cache
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        }, targetPluginId),
    );

    // A lazy wrapper is required for the reload path exercised below.
    const commandId = (await obsidian.findCommands(`${targetPluginId}:`))[0];
    expect(commandId).toBeTruthy();

    // Manual enable must finish loading before testing disable and lazy reload.
    await obsidian.page.evaluate((id) => app.plugins.enablePlugin(id), targetPluginId);
    await obsidian.waitForPluginLoaded(targetPluginId, 15_000);

    // Attempt to disable (ensure call completes)
    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);
    await obsidian.waitForPluginUnloaded(targetPluginId);

    // Ensure the test environment is still responsive
    expect(await obsidian.vaultName()).toBeTruthy();

    await obsidian.command(commandId);
    await obsidian.waitForPluginLoaded(targetPluginId, 15_000);
});

test("manual enable/disable is stable for lazy + useView", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    // Configure plugin as lazy + useView
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.core.settingsService.activeProfile.settings.plugins[pluginId].lazyOptions = {
                useView: true,
                viewTypes: ["markdown"],
                useFile: false,
                fileCriteria: {},
            };
            plugin.core.settingsService.activeProfile.settings.lazyOnViews = plugin.core.settingsService.activeProfile.settings.lazyOnViews || {};
            plugin.core.settingsService.activeProfile.settings.lazyOnViews[pluginId] = ["markdown"];
            await plugin.saveSettings();
        }, targetPluginId),
    );

    // Manually enable plugin
    await obsidian.page.evaluate((id) => app.plugins.enablePlugin(id), targetPluginId);
    await obsidian.waitForPluginLoaded(targetPluginId);

    // Manually disable plugin
    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);
    await obsidian.waitForPluginUnloaded(targetPluginId);

    // Trigger view change to cause lazy + useView load
    expect(await obsidian.isPluginLoaded(targetPluginId)).toBe(false);
    await obsidian.createNote("lazy-view-trigger.md", "");
    await obsidian.open("lazy-view-trigger.md");
    await triggerActiveLeafChange(obsidian);

    await obsidian.waitForPluginLoaded(targetPluginId);
});
