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
    // Settings open in a separate window on Obsidian 1.13, so the main vault page does not contain its UI.
    const settingsPagePromise = page.context().waitForEvent("page");
    await page.evaluate(() => app.setting.open());
    const settingsPage = await settingsPagePromise;
    await settingsPage.waitForLoadState("domcontentloaded");
    await settingsPage.evaluate(() => app.setting.openTabById("on-demand-plugins"));

    const pluginManagementLink = settingsPage.getByText("Plugin management", { exact: true });
    await expect(pluginManagementLink).toBeVisible();
    await pluginManagementLink.click();

    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🤲 Lazy on demand");

    await row.locator(".clickable-icon").click();
    await expect(settingsPage.getByText("Disable plugin", { exact: true })).toBeVisible();
    await settingsPage.getByText("🚀 Lazy on layout ready", { exact: true }).click();

    // Exercise the real menu-to-row path: the page keeps the row mounted while it stages this edit.
    await expect(row).toBeVisible();
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🚀 Lazy on layout ready");
    await expect(settingsPage.locator(".lazy-plugin-save-controls button")).toHaveText("Save & apply (1)");
});
