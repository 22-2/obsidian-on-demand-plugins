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

function ensureBuilt() {
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!fs.existsSync(mainJsPath)) {
        test.skip(true, "main.js not found; run build before tests");
        return false;
    }
    return true;
}

test("lazyOnView loads plugin on view activation", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = async () => undefined;

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
