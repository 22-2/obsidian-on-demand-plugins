import type { Page } from "@playwright/test";
import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

const MOBILE_WIDTHS = [320, 390] as const;
const MOBILE_HEIGHT = 844;
const CAPTURED_PAGES = ["Profile management", "Behaviour", "Maintenance & batch"] as const;

async function openMobileSettingsPage(obsidian: ObsidianAPI, pageName: string): Promise<Page> {
    const page = await obsidian.openSettings(pluginUnderTestId, { subPage: pageName });
    await obsidian.emulateMobile("phone", page);
    return page;
}

test("captures changed settings pages at phone widths", async ({ obsidian }, testInfo) => {
    const artifactDir = path.resolve(".ci-artifacts/mobile-ui/settings-pages");
    await mkdir(artifactDir, { recursive: true });

    for (const pageName of CAPTURED_PAGES) {
        const page = await openMobileSettingsPage(obsidian, pageName);
        for (const width of MOBILE_WIDTHS) {
            await page.setViewportSize({ width, height: MOBILE_HEIGHT });
            await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

            const pageContent = page.locator(".setting-page.vertical-tab-content");
            await expect(pageContent).toContainText(pageName === "Behaviour" ? "Default mode" : pageName === "Profile management" ? "Profiles" : "Cache maintenance");
            const screenshotPath = path.join(artifactDir, `${pageName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${width}.png`);
            await page.screenshot({ path: screenshotPath, animations: "disabled" });
            await testInfo.attach(`${pageName} ${width}px`, { path: screenshotPath, contentType: "image/png" });
        }
    }

    // Lazy options gained a taller, conditional form in this release range.
    // Capture the expanded state too, where wrapping and the footer compete for phone space.
    const pluginPage = await openMobileSettingsPage(obsidian, "Plugin management");
    await pluginPage.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await pluginPage.locator(".lazy-plugin-filter-row input").fill("BRAT");
    const row = pluginPage.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await row.getByRole("button", { name: "Actions", exact: true }).click();
    await pluginPage.locator(".menu-item").filter({ hasText: "Lazy settings" }).click();

    const optionsPage = await obsidian.findPage((candidate) => candidate.locator(".modal").filter({ hasText: "Lazy options for" }), { timeout: 10_000 });
    await optionsPage.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await obsidian.emulateMobile("phone", optionsPage);
    await optionsPage.locator(".setting-item").filter({ hasText: "Lazy on file" }).locator(".checkbox-container").click();
    await expect(optionsPage.getByText("File suffixes", { exact: true })).toBeVisible();
    const modalScreenshotPath = path.join(artifactDir, "lazy-options-expanded-390.png");
    await optionsPage.screenshot({ path: modalScreenshotPath, animations: "disabled" });
    await testInfo.attach("Lazy options expanded 390px", { path: modalScreenshotPath, contentType: "image/png" });
});
