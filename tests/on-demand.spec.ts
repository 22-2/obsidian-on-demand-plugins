import path from "node:path";
import fs from "node:fs";
import { test, expect } from "obsidian-e2e-toolkit";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const pluginUnderTestId = "on-demand-plugins";
const targetPluginId = "obsidian42-brat";

test.use({
    vaultOptions: {
        logLevel: "info",
        fresh: true,
        plugins: [
            {
                path: repoRoot,
                pluginId: pluginUnderTestId,
            },
            {
                path: path.resolve(repoRoot, "myfiles", targetPluginId),
                pluginId: targetPluginId,
            },
        ],
    },
});

test("on-demand: lazy command enables plugin", async ({ obsidian }) => {
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!fs.existsSync(mainJsPath)) {
        test.skip(true, "main.js not found; run build before tests");
        return;
    }

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
