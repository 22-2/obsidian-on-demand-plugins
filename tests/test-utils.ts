import path from "node:path";
import fs from "node:fs";
import { test } from "obsidian-e2e-toolkit";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const pluginUnderTestId = "on-demand-plugins";
const targetPluginId = "obsidian42-brat";
const excalidrawPluginId = "obsidian-excalidraw-plugin";

export function useOnDemandPlugins() {
    test.use({
        vaultOptions: {
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
}

export function useOnDemandPluginsWithExcalidraw() {
    test.use({
        vaultOptions: {
            logLevel: "info",
            fresh: true,
            plugins: [
                {
                    path: repoRoot,
                },
                {
                    path: path.resolve(repoRoot, "myfiles", excalidrawPluginId),
                },
            ],
        },
    });
}

export function ensureBuilt() {
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!fs.existsSync(mainJsPath)) {
        test.skip(true, "main.js not found; run build before tests");
        return false;
    }
    return true;
}

export { repoRoot, pluginUnderTestId, targetPluginId, excalidrawPluginId };
