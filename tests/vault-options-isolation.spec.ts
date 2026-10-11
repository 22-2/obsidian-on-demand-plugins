import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "obsidian-e2e-toolkit";
import { resolveMyfilesPluginPath, targetPluginId, useVaultPlugins } from "./test-utils";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Both groups must share one worker in this order: the toolkit used to merge vaultOptions into
// its shared defaults, so a longer plugin list leaked its tail into later tests (patches/).
test.describe.configure({ mode: "serial" });

test.describe("a test with a longer plugin list", () => {
    useVaultPlugins([repoRoot, path.join(repoRoot, "tests/fixtures/cache-async"), path.join(repoRoot, "tests/fixtures/cache-empty")]);

    test("installs every requested plugin", async ({ obsidian }) => {
        await obsidian.waitReady();
        const ids = await obsidian.page.evaluate(() => Object.keys(app.plugins.manifests).sort());
        expect(ids).toEqual(["cache-async", "cache-empty", "on-demand-plugins"]);
    });
});

test.describe("a later test with a shorter plugin list", () => {
    useVaultPlugins([repoRoot, resolveMyfilesPluginPath(targetPluginId)]);

    test("installs only its own plugins", async ({ obsidian }) => {
        await obsidian.waitReady();
        const ids = await obsidian.page.evaluate(() => Object.keys(app.plugins.manifests).sort());
        expect(ids).toEqual(["obsidian42-brat", "on-demand-plugins"]);
    });
});
