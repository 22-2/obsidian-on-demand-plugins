import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    pluginUnderTestId,
    targetPluginId,
    useOnDemandPlugins,
} from "./test-utils";

useOnDemandPlugins();

test("plugin management row menu stages a mode change in place", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        // Start from a known mode so the row badge and toggle action are deterministic.
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    const page = obsidian.page;
    await page.evaluate(() => {
        (app as unknown as { setting: { open: () => void } }).setting.open();
    });
    const settingsTab = page.getByText("On-Demand", { exact: true });
    await expect(settingsTab).toBeVisible();
    await settingsTab.click();

    const pluginManagementLink = page.getByText("Plugin management", { exact: true });
    await expect(pluginManagementLink).toBeVisible();
    await pluginManagementLink.click();

    await page.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = page.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🤲 Lazy on demand");

    await row.locator(".clickable-icon").click();
    await expect(page.getByText("Disable plugin", { exact: true })).toBeVisible();
    await page.getByText("🚀 Lazy on layout ready", { exact: true }).click();

    // Exercise the real menu-to-row path: the page keeps the row mounted while it stages this edit.
    await expect(row).toBeVisible();
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🚀 Lazy on layout ready");
    await expect(page.locator(".lazy-plugin-save-controls button")).toHaveText("Save & apply (1)");
});
