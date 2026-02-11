import path from "node:path";
import { test, expect, fetchPlugin } from "obsidian-e2e-toolkit";

import { fileURLToPath } from "url"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.use({
    vaultOptions: {
        logLevel: "info",
        fresh: true,
        plugins: [
            {
                path: path.resolve(__dirname, "..", "myfiles", "obsidian42-brat"),
            },
        ],
    },
});

test("plugin activation", async ({ obsidian }) => {
    expect(await obsidian.isPluginEnabled("obsidian42-brat")).toBe(true);
    expect(await obsidian.plugin("obsidian42-brat")).toBeTruthy();
});
