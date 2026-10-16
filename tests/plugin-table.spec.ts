import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

type TablePlugin = { openPluginTable: () => Promise<void>; getPluginMode: (id: string) => string; updatePluginSettings: (id: string, mode: string) => Promise<void> };

async function startFrom(obsidian: ObsidianAPI, mode: string) {
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance, [id, next]) => (instance as unknown as TablePlugin).updatePluginSettings(id, next), [targetPluginId, mode] as const);
    return plugin;
}

async function openTable(obsidian: ObsidianAPI) {
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await expect(view).toBeVisible();
    await view.getByRole("textbox", { name: "Filter Name" }).fill("BRAT");
    const row = view.locator("tbody tr").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    return { view, row };
}

function modeOf(obsidian: ObsidianAPI) {
    return obsidian.page.evaluate((id) => (app.plugins.plugins["on-demand-plugins"] as unknown as TablePlugin).getPluginMode(id), targetPluginId);
}

test("plugin table stages a mode from its column and saves it through the shared review", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const { view, row } = await openTable(obsidian);

    const gear = row.locator(".lazy-plugin-table-mode-cell .clickable-icon");
    await expect(gear).not.toHaveClass(/is-disabled/);
    await row.getByRole("combobox", { name: /^Mode for / }).selectOption("lazyOnLayoutReady");

    // The lazy options apply only to Lazy on demand, so the gear stays in place but disabled.
    await expect(gear).toHaveClass(/is-disabled/);
    const pending = view.locator(".lazy-plugin-table-pending");
    await expect(pending).toContainText("1 unsaved change · 1 plugin");
    // The table never toggles plugins, so nothing is saved until the review.
    expect(await modeOf(obsidian)).toBe("lazyOnLayoutReady");

    // Applying policies normally reloads Obsidian; intercept only that reload so the saved state can be inspected.
    const reload = await obsidian.interceptReload();
    await pending.getByRole("button", { name: "Review & save…", exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    const review = reviewPage.locator(".lazy-review-changes-modal");
    await expect(review.getByText("🚀 Lazy on layout ready", { exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Save & apply (1)", exact: true }).click();

    await expect(pending).toContainText("No unsaved changes");
    await expect.poll(() => reload.requested()).toBe(true);
    await reload.restore();
    expect(await modeOf(obsidian)).toBe("lazyOnLayoutReady");
});

test("closing the plugin table sets its draft aside and offers it back on reopen", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const { row } = await openTable(obsidian);
    await row.getByRole("combobox", { name: /^Mode for / }).selectOption("alwaysDisabled");

    await obsidian.page.evaluate(() => app.workspace.getLeavesOfType("on-demand-plugin-table").forEach((leaf) => leaf.detach()));
    // Until the user decides, On-Demand runs on the saved settings.
    await expect.poll(() => modeOf(obsidian)).toBe("lazy");

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    const restorePage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal").filter({ hasText: "Restore unsaved changes" }), { timeout: 10_000 });
    await restorePage.getByRole("button", { name: "Restore (1)", exact: true }).click();

    await expect.poll(() => modeOf(obsidian)).toBe("alwaysDisabled");
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await view.getByRole("textbox", { name: "Filter Name" }).fill("BRAT");
    await expect(view.locator("tbody tr").filter({ hasText: "BRAT" }).getByRole("combobox", { name: /^Mode for / })).toHaveValue("alwaysDisabled");
    await expect(view.locator(".lazy-plugin-table-pending")).toContainText("1 unsaved change");
});

test("plugin table switches to the touch layout on phones", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    // Mobile classes must be in place before the view opens, since the table picks its layout when it is built.
    await obsidian.emulateMobile("phone");
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    // Obsidian's mobile styles hide the desktop workspace under emulation, so this checks the built layout, not its pixels.
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    const row = view.locator("tbody tr").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);

    // Phones hide the long text columns at first so the name and mode fit.
    await expect(view.locator("thead .lazy-plugin-table-col-author")).toHaveCount(0);
    await expect(view.locator("thead .lazy-plugin-table-col-description")).toHaveCount(0);
    // Touch screens have no right-click, so each row gets a menu button.
    const actions = row.locator(".lazy-plugin-table-col-actions .clickable-icon");
    await expect(actions).toHaveCount(1);

    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");
    await actions.dispatchEvent("click");
    await expect(obsidian.page.locator(".menu-item").filter({ hasText: "Show in community plugins" })).toHaveCount(1);
});
