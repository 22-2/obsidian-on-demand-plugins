import type { Page } from "@playwright/test";
import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { expectCompactList, toggleCompactList } from "./screenshot-helpers";
import { pluginUnderTestId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

const SCREENSHOT_DEVICE = process.env.UI_SCREENSHOT_DEVICE ?? "mobile";
if (SCREENSHOT_DEVICE !== "pc" && SCREENSHOT_DEVICE !== "mobile") throw new Error("UI_SCREENSHOT_DEVICE must be pc or mobile");
const SCREENSHOT_WIDTHS = SCREENSHOT_DEVICE === "mobile" ? [320, 390] : [900];
const SCREENSHOT_HEIGHT = SCREENSHOT_DEVICE === "mobile" ? 844 : 877;
const CAPTURED_PAGES = ["Profile management", "Behaviour", "Maintenance & batch"] as const;
const SCREENSHOT_THEMES = ["light", "dark"] as const;
type ScreenshotTheme = (typeof SCREENSHOT_THEMES)[number];

async function prepareScreenshotPage(obsidian: ObsidianAPI, page: Page, theme: ScreenshotTheme): Promise<void> {
    if (SCREENSHOT_DEVICE === "mobile") await obsidian.emulateMobile("phone", page);
    await obsidian.setTheme(theme, page);
    await expect(page.locator("body")).toHaveClass(new RegExp(`\\btheme-${theme}\\b`));
}

async function openSettingsPage(obsidian: ObsidianAPI, pageName: string, theme: ScreenshotTheme): Promise<Page> {
    const page = await obsidian.openSettings(pluginUnderTestId, { subPage: pageName });
    await prepareScreenshotPage(obsidian, page, theme);
    return page;
}

for (const theme of SCREENSHOT_THEMES) {
    test(`captures plugin UI screenshots for ${SCREENSHOT_DEVICE} in ${theme} mode`, async ({ obsidian }, testInfo) => {
        const artifactDir = path.resolve(`.ci-artifacts/ui-screenshots/${SCREENSHOT_DEVICE}/${theme}`);
        await mkdir(artifactDir, { recursive: true });

        for (const pageName of CAPTURED_PAGES) {
            const page = await openSettingsPage(obsidian, pageName, theme);
            for (const width of SCREENSHOT_WIDTHS) {
                await page.setViewportSize({ width, height: SCREENSHOT_HEIGHT });
                await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

                const pageContent = page.locator(".setting-page.vertical-tab-content");
                await expect(pageContent).toContainText(pageName === "Behaviour" ? "Default mode" : pageName === "Profile management" ? "Profiles" : "Cache maintenance");
                const screenshotPath = path.join(artifactDir, `${pageName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${width}.png`);
                await page.screenshot({ path: screenshotPath, animations: "disabled" });
                await testInfo.attach(`${pageName} ${width}px`, { path: screenshotPath, contentType: "image/png" });
                if (pageName === "Maintenance & batch") {
                    const advanced = page.locator(".lazy-maintenance-advanced");
                    await advanced.locator("summary").click();
                    await expect(advanced.getByRole("button", { name: "Replace all", exact: true })).toBeVisible();
                    const expandedPath = path.join(artifactDir, `maintenance-batch-advanced-${width}.png`);
                    await page.screenshot({ path: expandedPath, animations: "disabled" });
                    await testInfo.attach(`Advanced maintenance ${width}px`, { path: expandedPath, contentType: "image/png" });
                    await advanced.locator("summary").click();
                }
            }
        }

        // Capture the primary page, compact list, and conditional advanced form.
        let pluginPage = await openSettingsPage(obsidian, "Plugin management", theme);
        const primaryWidth = SCREENSHOT_DEVICE === "mobile" ? 390 : 900;
        for (const width of SCREENSHOT_WIDTHS) {
            await pluginPage.setViewportSize({ width, height: SCREENSHOT_HEIGHT });
            const pluginScreenshotPath = path.join(artifactDir, `plugin-management-${width}.png`);
            await pluginPage.screenshot({ path: pluginScreenshotPath, animations: "disabled" });
            await testInfo.attach(`Plugin management ${width}px`, { path: pluginScreenshotPath, contentType: "image/png" });
        }

        await pluginPage.setViewportSize({ width: primaryWidth, height: SCREENSHOT_HEIGHT });
        await toggleCompactList(pluginPage);
        await expectCompactList(pluginPage);
        const compactPath = path.join(artifactDir, `plugin-management-compact-${primaryWidth}.png`);
        await pluginPage.screenshot({ path: compactPath, animations: "disabled" });
        await testInfo.attach(`Compact plugin management ${primaryWidth}px`, { path: compactPath, contentType: "image/png" });
        await toggleCompactList(pluginPage);

        // Obsidian renders Menu API popups as native menus on macOS, outside Playwright's DOM.
        if (process.platform === "darwin") return;

        await pluginPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
        const row = pluginPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
        const actions = SCREENSHOT_DEVICE === "mobile" ? row.getByRole("button", { name: "Actions", exact: true }) : row.locator(".lazy-plugin-row-actions-desktop");
        await actions.click();
        const actionsMenuPath = path.join(artifactDir, `plugin-actions-${primaryWidth}.png`);
        await pluginPage.screenshot({ path: actionsMenuPath, animations: "disabled" });
        await testInfo.attach(`Plugin actions menu ${primaryWidth}px`, { path: actionsMenuPath, contentType: "image/png" });
        await pluginPage.locator(".menu-item").filter({ hasText: "Lazy settings" }).click();

        const optionsPage = await obsidian.findPage((candidate) => candidate.locator(".modal").filter({ hasText: "Lazy options for" }), { timeout: 10_000 });
        await optionsPage.setViewportSize({ width: primaryWidth, height: SCREENSHOT_HEIGHT });
        await prepareScreenshotPage(obsidian, optionsPage, theme);
        await optionsPage.locator(".setting-item").filter({ hasText: "Lazy on file" }).locator(".checkbox-container").click();
        await expect(optionsPage.getByText("File suffixes", { exact: true })).toBeVisible();
        const modalScreenshotPath = path.join(artifactDir, `lazy-options-expanded-${primaryWidth}.png`);
        await optionsPage.screenshot({ path: modalScreenshotPath, animations: "disabled" });
        await testInfo.attach(`Lazy options expanded ${primaryWidth}px`, { path: modalScreenshotPath, contentType: "image/png" });
        await optionsPage.getByRole("button", { name: "Cancel", exact: true }).click();

        await actions.click();
        await pluginPage.locator(".menu-item").filter({ hasText: "🤲 Lazy on demand" }).click();
        const reviewButton = pluginPage.getByRole("button", { name: "Review & save…", exact: true });
        await expect(reviewButton).toBeEnabled();
        await reviewButton.click();
        const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
        await reviewPage.setViewportSize({ width: primaryWidth, height: SCREENSHOT_HEIGHT });
        await prepareScreenshotPage(obsidian, reviewPage, theme);
        await obsidian.waitForAnimations(reviewPage);
        const reviewPath = path.join(artifactDir, `review-save-${primaryWidth}.png`);
        await reviewPage.screenshot({ path: reviewPath, animations: "disabled" });
        await testInfo.attach(`Save review ${primaryWidth}px`, { path: reviewPath, contentType: "image/png" });
        await reviewPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

        await pluginPage.getByRole("button", { name: "Discard…", exact: true }).click();
        const discardPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
        await discardPage.setViewportSize({ width: primaryWidth, height: SCREENSHOT_HEIGHT });
        await prepareScreenshotPage(obsidian, discardPage, theme);
        await obsidian.waitForAnimations(discardPage);
        const discardPath = path.join(artifactDir, `review-discard-${primaryWidth}.png`);
        await discardPage.screenshot({ path: discardPath, animations: "disabled" });
        await testInfo.attach(`Discard review ${primaryWidth}px`, { path: discardPath, contentType: "image/png" });
        await discardPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();

        // Capture the unsaved-draft recovery offer, including its remember-choice checkbox.
        await obsidian.page.evaluate(() => (app as unknown as { setting: { close: () => void } }).setting.close());
        pluginPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
        await prepareScreenshotPage(obsidian, pluginPage, theme);
        const restorePage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal").filter({ hasText: "Restore unsaved changes" }), { timeout: 10_000 });
        await restorePage.setViewportSize({ width: primaryWidth, height: SCREENSHOT_HEIGHT });
        await prepareScreenshotPage(obsidian, restorePage, theme);
        await expect(restorePage.getByLabel("Don't ask again")).toBeVisible();
        await obsidian.waitForAnimations(restorePage);
        const restorePath = path.join(artifactDir, `restore-draft-${primaryWidth}.png`);
        await restorePage.screenshot({ path: restorePath, animations: "disabled" });
        await testInfo.attach(`Restore draft ${primaryWidth}px`, { path: restorePath, contentType: "image/png" });
        await restorePage.keyboard.press("Escape");
    });
}
