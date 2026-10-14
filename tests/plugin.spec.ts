import { expect, test } from "./fixtures";
import { resolveMyfilesPluginPath, useVaultPlugins } from "./test-utils";

useVaultPlugins([resolveMyfilesPluginPath("obsidian42-brat")]);

test("plugin activation", async ({ obsidian }) => {
    expect(await obsidian.isPluginEnabled("obsidian42-brat")).toBe(true);
    expect(await obsidian.plugin("obsidian42-brat")).toBeTruthy();
});
