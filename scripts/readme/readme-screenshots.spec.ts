import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, useOnDemandPluginsWithTargets } from "../../tests/test-utils";

// Captures the README screenshots of the settings window, its review and discard dialogs, and the phone layout.
// Run with `pnpm readme:shots`. Set README_SHOT_DIR to choose the output folder (default: the OS temp directory).
const outDir = process.env.README_SHOT_DIR ?? path.join(os.tmpdir(), "readme-screenshots");

useOnDemandPluginsWithTargets(["obsidian42-brat", "obsidian-excalidraw-plugin", "obsidian-linter", "notebook-navigator"]);

async function openPluginManagement(page: Page): Promise<Page> {
    const settingsPagePromise = page.context().waitForEvent("page");
    await page.evaluate(() => {
        app.setting.open();
        app.setting.openTabById("on-demand-plugins");
    });
    const settingsPage = await settingsPagePromise;
    await settingsPage.waitForLoadState("domcontentloaded");
    await settingsPage.getByText("Plugin management", { exact: true }).click();
    return settingsPage;
}

// Playwright only: the settings page screenshot, rendered at the current viewport.
function captureWindow(page: Page, file: string): Promise<Buffer> {
    return page.screenshot({ path: path.join(outDir, file), animations: "disabled" });
}

test("capture README screenshots", async ({ obsidian }) => {
    if (!ensureBuilt()) return;
    await obsidian.waitReady();
    await mkdir(outDir, { recursive: true });

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate(async (instance) => {
        await instance.updatePluginSettings("obsidian42-brat", "lazyOnLayoutReady");
        await instance.updatePluginSettings("obsidian-excalidraw-plugin", "lazy");
        await instance.updatePluginSettings("obsidian-linter", "alwaysDisabled");
        await instance.updatePluginSettings("notebook-navigator", "lazy");
    });

    const settingsPage = await openPluginManagement(obsidian.page);
    await settingsPage.setViewportSize({ width: 1100, height: 877 });
    await settingsPage.evaluate(() => {
        document.body.classList.remove("theme-light");
        document.body.classList.add("theme-dark");
    });

    // Stage one change so the save bar and the review flow are part of the picture.
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("Excalidraw");
    const excalidrawRow = settingsPage.locator(".lazy-plugin-mode-row").filter({ hasText: "Excalidraw" });
    await expect(excalidrawRow).toHaveCount(1);
    await excalidrawRow.locator(".clickable-icon").click();
    const menuPage = await Promise.any(settingsPage.context().pages().map(async (candidate) => {
        await candidate.getByText("Status (in memory only)", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
        return candidate;
    }));
    await menuPage.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" }).click();
    await expect(settingsPage.locator(".lazy-plugin-save-controls")).toContainText("unsaved change");
    // Clear the filter so the captured list shows the whole set of plugins, not only the staged one.
    await settingsPage.locator(".lazy-plugin-filter-row input").fill("");
    await expect(settingsPage.locator(".lazy-plugin-mode-row")).toHaveCount(4);

    for (const width of [1100, 900, 700]) {
        await settingsPage.setViewportSize({ width, height: 877 });
        await settingsPage.waitForTimeout(600);
        await captureWindow(settingsPage, `window-${width}.png`);
    }

    // The OS window is 916px wide; a wider layout is clipped at its right edge, so keep the page within it.
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await settingsPage.waitForTimeout(500);
    await settingsPage.getByRole("button", { name: "Review & save…", exact: true }).click();
    await Promise.any(settingsPage.context().pages().map(async (candidate) => {
        await candidate.locator(".lazy-review-changes-modal").waitFor({ state: "visible" });
        return candidate;
    }));
    await settingsPage.waitForTimeout(500);
    await captureWindow(settingsPage, "window-review.png");
    await settingsPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

    // Discard: the same staged changes, previewed as what would be lost and restored.
    await settingsPage.getByRole("button", { name: "Discard…", exact: true }).click();
    await Promise.any(settingsPage.context().pages().map(async (candidate) => {
        await candidate.locator(".lazy-review-changes-modal").waitFor({ state: "visible" });
        return candidate;
    }));
    await settingsPage.waitForTimeout(500);
    await captureWindow(settingsPage, "window-discard.png");
    await settingsPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

    // Compact list: turn the toggle on in a desktop-width window for the one-line view.
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await settingsPage.waitForTimeout(500);
    const compactToggle = settingsPage.locator(".lazy-plugin-compact-control .checkbox-container");
    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await settingsPage.waitForTimeout(400);
    await captureWindow(settingsPage, "window-compact.png");
    await compactToggle.click();

    // Phone layout: the same classes and 390px viewport as the mobile spec. The OS window cannot shrink
    // this far (it stops at about 616px), so the phone shots are page screenshots rather than window captures.
    await settingsPage.evaluate(() => {
        document.body.classList.add("is-mobile", "is-phone", "is-android");
    });
    await settingsPage.setViewportSize({ width: 390, height: 844 });
    await settingsPage.waitForTimeout(600);
    await settingsPage.screenshot({ path: path.join(outDir, "mobile-settings.png"), animations: "disabled" });

    await settingsPage.getByRole("button", { name: "Review & save…", exact: true }).click();
    await Promise.any(settingsPage.context().pages().map(async (candidate) => {
        await candidate.locator(".lazy-review-changes-modal").waitFor({ state: "visible" });
        return candidate;
    }));
    await settingsPage.waitForTimeout(500);
    await settingsPage.screenshot({ path: path.join(outDir, "mobile-review.png"), animations: "disabled" });
    await settingsPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();
});
