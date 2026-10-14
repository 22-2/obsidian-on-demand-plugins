import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { pluginUnderTestId, useOnDemandPluginsWithTargets } from "../../tests/test-utils";

// Captures the settings window, lazy options, review and discard dialogs, and the phone layout.
// Run with `pnpm readme:shots`. README_SHOT_DIR overrides the default .ci-artifacts/ui-screenshots/readme folder.
// ss.png and ss-modal.png match the existing README asset names for drop-in replacement.
const outDir = process.env.README_SHOT_DIR ?? path.resolve(".ci-artifacts/ui-screenshots/readme");

useOnDemandPluginsWithTargets(["obsidian42-brat", "obsidian-excalidraw-plugin", "obsidian-linter", "notebook-navigator"]);

// Playwright only: the settings page screenshot, rendered at the current viewport.
async function captureWindow(page: Page, file: string): Promise<Buffer> {
    await page.evaluate(() => document.fonts.ready);
    return page.screenshot({ path: path.join(outDir, file), animations: "disabled" });
}

test("capture README screenshots", async ({ obsidian }) => {
    await mkdir(outDir, { recursive: true });

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate(async (instance) => {
        await instance.updatePluginSettings("obsidian42-brat", "lazyOnLayoutReady");
        await instance.updatePluginSettings("obsidian-excalidraw-plugin", "lazy");
        instance.settings.plugins["obsidian-excalidraw-plugin"].lazyOptions = {
            useView: true,
            viewTypes: ["excalidraw"],
            useFile: true,
            fileCriteria: { suffixes: [".excalidraw"], frontmatterKeys: ["excalidraw-plugin"] },
        };
        await instance.updatePluginSettings("obsidian-linter", "alwaysDisabled");
        await instance.updatePluginSettings("notebook-navigator", "lazy");
    });

    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.setViewportSize({ width: 1100, height: 877 });
    await obsidian.setTheme("dark", settingsPage);

    // Stage one change so the save bar and the review flow are part of the picture.
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("Excalidraw");
    const excalidrawRow = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "Excalidraw" });
    await expect(excalidrawRow).toHaveCount(1);
    await excalidrawRow.locator(".clickable-icon").click();
    const menuPage = await obsidian.findPage((candidate) => candidate.getByText("Status (in memory only)", { exact: true }), { timeout: 10_000 });
    await menuPage.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" }).click();
    await expect(settingsPage.locator(".lazy-plugin-save-controls")).toContainText("unsaved change");
    // Clear the filter so the captured list shows the whole set of plugins, not only the staged one.
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("");
    await expect(settingsPage.locator(".lazy-plugin-mode-row")).toHaveCount(4);

    for (const width of [1100, 900, 700]) {
        await settingsPage.setViewportSize({ width, height: 877 });
        await obsidian.waitForAnimations(settingsPage);
        await captureWindow(settingsPage, `window-${width}.png`);
    }

    // The OS window is 916px wide; a wider layout is clipped at its right edge, so keep the page within it.
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await obsidian.waitForAnimations(settingsPage);
    await captureWindow(settingsPage, "ss.png");
    await settingsPage.getByRole("button", { name: "Review & save…", exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await obsidian.waitForAnimations(settingsPage);
    await captureWindow(reviewPage, "window-review.png");
    await reviewPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

    // Discard: the same staged changes, previewed as what would be lost and restored.
    await settingsPage.getByRole("button", { name: "Discard…", exact: true }).click();
    const discardPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await obsidian.waitForAnimations(settingsPage);
    await captureWindow(discardPage, "window-discard.png");
    await discardPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

    // Compact list: turn the toggle on in a desktop-width window for the one-line view.
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await obsidian.waitForAnimations(settingsPage);
    const compactToggle = settingsPage.locator(".lazy-plugin-compact-control .checkbox-container");
    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await obsidian.waitForAnimations(settingsPage);
    await captureWindow(settingsPage, "window-compact.png");
    await compactToggle.click();

    // Match the existing README modal: Excalidraw with both activation rules and its file suffix visible.
    await excalidrawRow.locator(".lazy-plugin-row-actions-desktop").click();
    const optionsMenuPage = await obsidian.findPage((candidate) => candidate.getByText("Lazy settings", { exact: true }), { timeout: 10_000 });
    await optionsMenuPage.getByText("Lazy settings", { exact: true }).click();
    const optionsPage = await obsidian.findPage((candidate) => candidate.locator(".modal").filter({ hasText: "Lazy options for obsidian-excalidraw-plugin" }), { timeout: 10_000 });
    await optionsPage.setViewportSize({ width: 900, height: 877 });
    await obsidian.setTheme("dark", optionsPage);
    const optionsModal = optionsPage.locator(".modal").filter({ hasText: "Lazy options for obsidian-excalidraw-plugin" });
    await expect(optionsModal.locator(".setting-item").filter({ hasText: "File suffixes" }).locator("textarea")).toHaveValue(".excalidraw");
    await obsidian.waitForAnimations(optionsPage);
    await optionsPage.evaluate(() => document.fonts.ready);
    await optionsModal.screenshot({ path: path.join(outDir, "ss-modal.png"), animations: "disabled" });
    await optionsModal.getByRole("button", { name: "Cancel", exact: true }).click();

    // Phone layout: the same classes and 390px viewport as the mobile spec. The OS window cannot shrink
    // this far (it stops at about 616px), so the phone shots are page screenshots rather than window captures.
    await obsidian.emulateMobile("phone", settingsPage);
    await settingsPage.setViewportSize({ width: 390, height: 844 });
    await obsidian.waitForAnimations(settingsPage);
    await settingsPage.screenshot({ path: path.join(outDir, "mobile-settings.png"), animations: "disabled" });

    await settingsPage.getByRole("button", { name: "Review & save…", exact: true }).click();
    const mobileReviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await obsidian.waitForAnimations(settingsPage);
    await captureWindow(mobileReviewPage, "mobile-review.png");
    await mobileReviewPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();
});
