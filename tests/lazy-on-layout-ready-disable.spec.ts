import { test, expect } from "obsidian-e2e-toolkit";
import { pluginUnderTestId, targetPluginId, ensureBuilt, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

/**
 * Regression test: disabling a "lazyOnLayoutReady" plugin should NOT
 * cause it to be automatically re-enabled.
 *
 * The bug was that `disablePlugin` patch called `ensureCommandsCached`
 * for all lazy modes (including lazyOnLayoutReady), which internally
 * calls `enablePlugin` to gather commands — effectively re-enabling
 * the plugin the user just disabled.
 */
test("disabling a lazyOnLayoutReady plugin should not re-enable it", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Configure target plugin as lazyOnLayoutReady
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;
        try {
            await plugin.updatePluginSettings(pluginId, "lazyOnLayoutReady");
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    // 2. Enable the plugin (simulating that onLayoutReady loaded it)
    await obsidian.page.evaluate((id) => app.plugins.enablePlugin(id), targetPluginId);
    const enableDeadline = Date.now() + 8000;
    while (Date.now() < enableDeadline) {
        if (await obsidian.isPluginEnabled(targetPluginId)) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    expect(await obsidian.isPluginEnabled(targetPluginId)).toBe(true);

    // 3. User manually disables the plugin
    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

    // Wait for disable to complete
    const disableDeadline = Date.now() + 8000;
    let disabled = false;
    while (Date.now() < disableDeadline) {
        if (!(await obsidian.isPluginEnabled(targetPluginId))) {
            disabled = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    expect(disabled).toBe(true);

    // 4. Wait a bit and verify the plugin stays disabled (the bug would re-enable it)
    await new Promise((r) => setTimeout(r, 3000));
    const stillDisabled = !(await obsidian.isPluginEnabled(targetPluginId));
    expect(stillDisabled).toBe(true);
});

test("disabling a lazyOnLayoutReady plugin does not trigger ensureCommandsCached", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);

    // 1. Configure target plugin as lazyOnLayoutReady
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;
        try {
            await plugin.updatePluginSettings(pluginId, "lazyOnLayoutReady");
            await plugin.saveSettings();
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    // 2. Enable the plugin first
    await obsidian.page.evaluate((id) => app.plugins.enablePlugin(id), targetPluginId);
    const enableDeadline = Date.now() + 8000;
    while (Date.now() < enableDeadline) {
        if (await obsidian.isPluginEnabled(targetPluginId)) break;
        await new Promise((r) => setTimeout(r, 200));
    }

    // 3. Disable with reRegisterLazyCommandsOnDisable = true
    //    Even with this setting on, lazyOnLayoutReady should NOT re-register commands
    await pluginHandle.evaluate(async (plugin) => {
        plugin.settings.reRegisterLazyCommandsOnDisable = true;
        await plugin.saveSettings();
    });

    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

    // Wait for disable to take effect
    const disableDeadline = Date.now() + 8000;
    while (Date.now() < disableDeadline) {
        if (!(await obsidian.isPluginEnabled(targetPluginId))) break;
        await new Promise((r) => setTimeout(r, 200));
    }

    // 4. Verify plugin remains disabled after a delay
    await new Promise((r) => setTimeout(r, 3000));
    const isEnabled = await obsidian.isPluginEnabled(targetPluginId);
    expect(isEnabled).toBe(false);
});
