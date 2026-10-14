import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("plugin management row menu saves and applies a mode change in place", async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        // Start from a known mode so the row badge and toggle action are deterministic.
        await plugin.updatePluginSettings(pluginId, "lazy");
    }, targetPluginId);

    const page = obsidian.page;
    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });

    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🤲 Lazy on demand");

    // Obsidian's macOS menu is not exposed as a DOM menu in headless CI; Windows exercises the actual menu action.
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");

    await row.locator(".clickable-icon").click();
    // The Obsidian Menu API can render from the vault window even when its Settings row lives in another window.
    const menuPage = await obsidian.findPage((candidate) => candidate.getByText("Status (in memory only)", { exact: true }), { timeout: 10_000 });
    await menuPage.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" }).click();

    // Exercise the real menu-to-row path: the page keeps the row mounted while it stages this edit.
    await expect(row).toBeVisible();
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🚀 Lazy on layout ready");
    const saveButton = settingsPage.getByRole("button", { name: "Review & save…", exact: true });
    await expect(settingsPage.locator(".lazy-plugin-save-controls")).toContainText("1 unsaved change · 1 plugin");
    await expect(saveButton).toBeEnabled();

    // Applying policies normally reloads Obsidian; intercept only that reload so CI can inspect the saved state.
    const reload = await obsidian.interceptReload();
    await saveButton.click();
    // Saving opens a review of the staged draft first; it can render in whichever window holds focus.
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    const review = reviewPage.locator(".lazy-review-changes-modal");
    await expect(review.getByText("🚀 Lazy on layout ready", { exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Save & apply (1)", exact: true }).click();

    // Save controls are pinned only while a draft exists, so a successful
    // save removes the bar instead of leaving a disabled button behind.
    await expect(settingsPage.locator(".lazy-plugin-save-controls")).toHaveCount(0);
    await expect.poll(() => pluginHandle.evaluate((plugin, pluginId) => plugin.getPluginMode(pluginId), targetPluginId)).toBe("lazyOnLayoutReady");
    await expect.poll(() => reload.requested()).toBe(true);
    await reload.restore();
});

// Run with one worker (see the test:e2e script): these two are sensitive to parallel Obsidian instances.
test("plugin actions reveal the installed plugin in Obsidian's Community plugins tab", { tag: "@serial" }, async ({ obsidian }) => {
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");

    const page = obsidian.page;
    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });

    // Leave a core search that excludes the destination to verify navigation clears it.
    await page.evaluate(() => {
        app.setting.openTabById("community-plugins");
    });
    const coreSearch = settingsPage.locator(".vertical-tab-content input[type='search']");
    await coreSearch.fill("no-such-plugin");
    await page.evaluate(() => {
        app.setting.openTabById("on-demand-plugins");
    });
    await settingsPage.getByText("Plugin management", { exact: true }).click();
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await row.locator(".clickable-icon").click();
    const title = "Show in community plugins";
    const menuPage = await obsidian.findPage((candidate) => candidate.getByText(title, { exact: true }), { timeout: 10_000 });
    await menuPage.getByText(title, { exact: true }).click();

    await expect(coreSearch).toBeVisible();
    await expect(coreSearch).toHaveValue("");
    const destination = settingsPage.locator(`.vertical-tab-content [data-plugin-id="${targetPluginId}"]`);
    await expect(destination).toBeInViewport();
    // The animation proves the delayed reveal ran in the settings window after layout settled.
    await expect.poll(() => destination.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
});

// Run with one worker (see the test:e2e script): these two are sensitive to parallel Obsidian instances.
test("plugin management refresh updates the live loaded badge", { tag: "@serial" }, async ({ obsidian }) => {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await obsidian.page.evaluate(async (pluginId) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as (typeof app.plugins.plugins)[string] & {
            updatePluginSettings: (id: string, mode: "lazy") => Promise<void>;
        };
        await plugin.updatePluginSettings(pluginId, "lazy");
        await app.plugins.disablePlugin(pluginId);
        // disablePlugin keeps the id in the in-memory enabled set, and any later save would write it back.
        // Remove it from both the set and the file so the precondition is "not saved" for both.
        app.plugins.enabledPlugins.delete(pluginId);
        const savedPluginIds = await app.vault.readConfigJson("community-plugins");
        if (Array.isArray(savedPluginIds)) {
            await app.vault.writeConfigJson(
                "community-plugins",
                savedPluginIds.filter((id): id is string => typeof id === "string" && id !== pluginId),
            );
        }
    }, targetPluginId);

    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await expect(row.locator(".lazy-plugin-enabled-badge")).toHaveText("Not loaded");

    await obsidian.page.evaluate((pluginId) => app.plugins.enablePlugin(pluginId), targetPluginId);
    await expect.poll(() => obsidian.page.evaluate((pluginId) => Boolean(app.plugins.plugins[pluginId]?._loaded), targetPluginId)).toBe(true);

    const refreshButton = settingsPage.locator(".lazy-plugin-filter-row .clickable-icon");
    await refreshButton.click();
    const enabledBadge = row.locator(".lazy-plugin-enabled-badge");
    await expect(enabledBadge).toHaveText("Loaded (in memory only)");
    await expect(enabledBadge).toHaveClass(/is-memory-only/);

    await obsidian.page.evaluate(async (pluginId) => {
        const savedPluginIds = await app.vault.readConfigJson("community-plugins");
        const savedIds = Array.isArray(savedPluginIds) ? savedPluginIds.filter((id): id is string => typeof id === "string") : [];
        // Add to the in-memory set too; a pending debounced save would otherwise overwrite this file write without the id.
        app.plugins.enabledPlugins.add(pluginId);
        await app.vault.writeConfigJson("community-plugins", [...new Set([...savedIds, pluginId])]);
    }, targetPluginId);
    await refreshButton.click();
    await expect(enabledBadge).toHaveText("Loaded");
    await expect(enabledBadge).not.toHaveClass(/is-memory-only/);
});

// Run with one worker (see the test:e2e script): sensitive to parallel Obsidian instances.
test("plugin management follows loads made outside the page without a refresh", { tag: "@serial" }, async ({ obsidian }) => {
    await obsidian.page.evaluate(async (pluginId) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as (typeof app.plugins.plugins)[string] & {
            updatePluginSettings: (id: string, mode: "lazy") => Promise<void>;
        };
        await plugin.updatePluginSettings(pluginId, "lazy");
        await app.plugins.disablePlugin(pluginId);
    }, targetPluginId);

    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const badge = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" }).locator(".lazy-plugin-enabled-badge");
    await expect(badge).not.toHaveClass(/is-loaded/);

    // A lazy trigger loads through Obsidian's loader, not through this page.
    await obsidian.page.evaluate(async (pluginId) => {
        await app.plugins.loadPlugin(pluginId);
    }, targetPluginId);
    await expect(badge).toHaveClass(/is-loaded/);

    await obsidian.page.evaluate((pluginId) => app.plugins.unloadPlugin(pluginId), targetPluginId);
    await expect(badge).not.toHaveClass(/is-loaded/);
});

test("pressing the row actions control again closes its open menu", async ({ obsidian }) => {
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");

    const page = obsidian.page;
    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const actions = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" }).locator(".clickable-icon");

    await actions.click();
    // The menu can render in either window, so find whichever page shows it.
    const menuPage = await obsidian.findPage((candidate) => candidate.getByText("Status (in memory only)", { exact: true }), { timeout: 10_000 });
    const menu = menuPage.locator(".menu");
    await expect(menu).toHaveCount(1);

    await actions.click();
    await expect(menu).toHaveCount(0);
});
