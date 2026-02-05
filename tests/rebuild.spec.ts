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

test("force rebuild refreshes command cache", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const beforeUpdatedAt = plugin.data?.commandCacheUpdatedAt ?? null;
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = async () => undefined;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }

        return {
            beforeUpdatedAt,
            afterUpdatedAt: plugin.data?.commandCacheUpdatedAt ?? null,
            cacheCount: plugin.data?.commandCache?.[pluginId]?.length ?? 0,
        };
    }, targetPluginId);

    expect(result.afterUpdatedAt).toBeTruthy();
    if (result.beforeUpdatedAt) {
        expect(result.afterUpdatedAt).toBeGreaterThanOrEqual(
            result.beforeUpdatedAt,
        );
    }
    expect(result.cacheCount).toBeGreaterThanOrEqual(0);
});

test("commandCacheVersions updates on force rebuild", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }

        const manifestVersion = app.plugins.manifests?.[pluginId]?.version ?? null;
        const cachedVersion = plugin.data?.commandCacheVersions?.[pluginId] ?? null;
        return { manifestVersion, cachedVersion };
    }, targetPluginId);

    expect(result.manifestVersion).toBeTruthy();
    expect(result.cachedVersion).toBe(result.manifestVersion);
});

test("reRegisterLazyCommandsOnDisable keeps command wrappers", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            plugin.settings.reRegisterLazyCommandsOnDisable = true;
            await plugin.saveSettings();
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    }, targetPluginId);

    const commandId = await obsidian.page.evaluate((id) => {
        return Object.keys(app.commands.commands).find((cmd) =>
            cmd.startsWith(`${id}:`),
        );
    }, targetPluginId);

    expect(commandId).toBeTruthy();

    await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), targetPluginId);

    const stillExists = await obsidian.page.evaluate((cmd) => {
        return Boolean(app.commands.commands[cmd]);
    }, commandId as string);

    expect(stillExists).toBe(true);
});
