import { expect, test } from "obsidian-e2e-toolkit";
import type { Page } from "@playwright/test";
import {
    ensureBuilt,
    pluginUnderTestId,
    targetPluginId,
    useOnDemandPlugins,
} from "./test-utils";

useOnDemandPlugins();

async function openPluginManagement(page: Page): Promise<Page> {
    // Obsidian 1.13 opens Settings in a separate window, so follow that page for settings UI assertions.
    const settingsPagePromise = page.context().waitForEvent("page");
    await page.evaluate(() => {
        app.setting.open();
        app.setting.openTabById("on-demand-plugins");
    });
    const settingsPage = await settingsPagePromise;
    await settingsPage.waitForLoadState("domcontentloaded");

    const pluginManagementLink = settingsPage.getByText("Plugin management", { exact: true });
    await expect(pluginManagementLink).toBeVisible();
    await pluginManagementLink.click();
    return settingsPage;
}

test("plugin management row menu saves and applies a mode change in place", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        // Start from a known mode so the row badge and toggle action are deterministic.
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    const page = obsidian.page;
    const settingsPage = await openPluginManagement(page);

    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🤲 Lazy on demand");

    // Obsidian's macOS menu is not exposed as a DOM menu in headless CI; Windows exercises the actual menu action.
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");

    await row.locator(".clickable-icon").click();
    // The Obsidian Menu API can render from the vault window even when its Settings row lives in another window.
    const menuPage = await Promise.any(
        page.context().pages().map(async (candidate) => {
            await candidate.getByText("Disable plugin", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
            return candidate;
        }),
    );
    await menuPage.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" }).click();

    // Exercise the real menu-to-row path: the page keeps the row mounted while it stages this edit.
    await expect(row).toBeVisible();
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🚀 Lazy on layout ready");
    const saveButton = settingsPage.getByRole("button", { name: "Save & apply (1)", exact: true });
    await expect(saveButton).toBeEnabled();

    // Applying policies normally reloads Obsidian; intercept only that reload so CI can inspect the saved state.
    await page.evaluate(() => {
        const commands = app.commands as unknown as {
            executeCommandById: (commandId: string) => unknown;
            __originalExecuteCommandById?: (commandId: string) => unknown;
            __requestedReload?: boolean;
        };
        commands.__originalExecuteCommandById = commands.executeCommandById;
        commands.__requestedReload = false;
        commands.executeCommandById = ((commandId: string) => {
            if (commandId === "app:reload") {
                commands.__requestedReload = true;
                return true;
            }
            return commands.__originalExecuteCommandById?.call(commands, commandId) ?? false;
        });
    });
    await saveButton.click();

    await expect(settingsPage.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect.poll(() => pluginHandle.evaluate((plugin, pluginId) => plugin.getPluginMode(pluginId), targetPluginId)).toBe("lazyOnLayoutReady");
    expect(await page.evaluate(() => (app.commands as unknown as { __requestedReload?: boolean }).__requestedReload)).toBe(true);
});

test("plugin management refresh updates the live loaded badge", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await obsidian.page.evaluate(async (pluginId) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as typeof app.plugins.plugins[string] & {
            updatePluginSettings: (id: string, mode: "lazy") => Promise<void>;
        };
        await plugin.updatePluginSettings(pluginId, "lazy");
        await app.plugins.disablePlugin(pluginId);
    }, targetPluginId);

    const settingsPage = await openPluginManagement(obsidian.page);
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row.locator(".lazy-plugin-enabled-badge")).toHaveText("Not loaded");

    await obsidian.page.evaluate((pluginId) => app.plugins.enablePlugin(pluginId), targetPluginId);
    await expect.poll(() => obsidian.page.evaluate((pluginId) => Boolean(app.plugins.plugins[pluginId]?._loaded), targetPluginId)).toBe(true);
    // The badge is intentionally a snapshot until Refresh plugin list re-renders the row.
    await expect(row.locator(".lazy-plugin-enabled-badge")).toHaveText("Not loaded");

    const pluginsHeading = settingsPage.locator(".setting-item-heading").filter({ hasText: "Plugins" });
    await pluginsHeading.locator(".clickable-icon").click();
    await expect(row.locator(".lazy-plugin-enabled-badge")).toHaveText("Loaded");
});
