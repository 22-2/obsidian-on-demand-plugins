import path from "node:path";
import { test, expect } from "obsidian-e2e-toolkit";

import { fileURLToPath } from "url"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.use({
    vaultOptions: {
        fresh: true,
        plugins: [
            {
                path: path.resolve(__dirname, "..", "myfiles", "plugin.js"),
                pluginId: "sample-plugin",
            },
        ],
    },
});

test("plugin activation", async ({ obsidian }) => {
    expect(await obsidian.isPluginEnabled("sample-plugin")).toBe(true);
    expect(await obsidian.plugin("sample-plugin")).toBeTruthy();
});
