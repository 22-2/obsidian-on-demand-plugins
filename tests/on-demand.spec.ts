import path from "node:path";
import { test, expect } from "obsidian-e2e-toolkit";

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
    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    expect(await obsidian.isPluginEnabled(targetPluginId)).toBe(false);

    const commandId = await obsidian.page.evaluate((id) => {
        return Object.keys(app.commands.commands).find((cmd) =>
            cmd.startsWith(`${id}:`),
        );
    }, targetPluginId);

    expect(commandId).toBeTruthy();
    await obsidian.command(commandId as string);

    expect(await obsidian.isPluginEnabled(targetPluginId)).toBe(true);
});
