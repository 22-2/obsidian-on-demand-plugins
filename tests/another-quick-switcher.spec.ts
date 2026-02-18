import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, repoRoot } from "./test-utils";
import path from "node:path";

const targetPluginId = "obsidian-another-quick-switcher";

test.use({
    vaultOptions: {
        enableBrowserConsoleLogging: true,
        logLevel: "info",
        fresh: true,
        plugins: [
            {
                path: repoRoot,
            },
            {
                path: path.resolve(repoRoot, "myfiles", targetPluginId),
            },
        ],
    },
});

test("Another Quick Switcher: should NOT be loaded at startup when set to lazy", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    
    // 1. Set to lazy mode
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    // 2. Restart Obsidian to check startup state
    await obsidian.page.reload();
    await obsidian.waitReady();

    // 3. Verify it is NOT enabled
    const isEnabled = await obsidian.isPluginEnabled(targetPluginId);
    console.log(`Plugin enabled state: ${isEnabled}`);

    // Check community-plugins.json
    const communityPlugins = await obsidian.page.evaluate(async () => {
        const raw = await app.vault.adapter.read('.obsidian/community-plugins.json');
        return JSON.parse(raw) as string[];
    });
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
