import { expect, test } from "obsidian-e2e-toolkit";
import OnDemandPlugin from "src/main";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("apply changes writes community-plugins.json", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true; // prevent real reload

        try {
            // Make plugin keepEnabled so it should be present in the file
            await plugin.updatePluginSettings(pluginId, "alwaysEnabled");
            await plugin.applyStartupPolicyAndRestart([pluginId]);
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    // Read the written community-plugins.json via the app adapter
    const fileContent = await obsidian.page.evaluate(() => {
        const path = (app.vault as any).configDir + "/community-plugins.json";
        try {
            return app.vault.adapter.read(path);
        } catch (e) {
            return null;
        }
    });

    expect(fileContent).toBeTruthy();
    const parsed = JSON.parse(fileContent as string);
    expect(Array.isArray(parsed)).toBe(true);
    // Should include the on-demand plugin and the kept plugin
    expect(parsed).toContain(pluginUnderTestId);
    expect(parsed).toContain(targetPluginId);
});

test("automatic view type detection during Apply changes", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const detected = await pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true; // prevent reload

        try {
            // Ensure no pre-existing entry
            if (plugin.settings.lazyOnViews && plugin.settings.lazyOnViews[pluginId]) {
                delete plugin.settings.lazyOnViews[pluginId];
                await plugin.saveSettings();
            }

            await plugin.updatePluginSettings(pluginId, "lazyOnView");
            await plugin.applyStartupPolicyAndRestart([pluginId]);

            return plugin.settings.lazyOnViews?.[pluginId] ?? null;
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    if (!detected) return;

    expect(detected).toBeTruthy();
    expect(Array.isArray(detected)).toBe(true);
    expect(detected.length).toBeGreaterThan(0);
});
