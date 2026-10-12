import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, useOnDemandPlugins } from "../../tests/test-utils";

// Captures a long plugin list on desktop and phone, normal and compact. Run with `pnpm readme:shots`.
const outDir = process.env.README_SHOT_DIR ?? path.join(os.tmpdir(), "readme-screenshots");

useOnDemandPlugins();

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

test("many plugins preview on desktop and phone", async ({ obsidian }) => {
    if (!ensureBuilt()) return;
    await obsidian.waitReady();
    await mkdir(outDir, { recursive: true });

    // 36 small inert plugins in the isolated vault, so the list is long enough to scroll.
    await obsidian.page.evaluate(async () => {
        for (let index = 1; index <= 36; index++) {
            const number = String(index).padStart(2, "0");
            const id = `mobile-ui-fixture-${number}`;
            const dir = `${app.vault.configDir}/plugins/${id}`;
            await app.vault.adapter.mkdir(dir);
            await app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify({
                id, name: `Mobile fixture ${number}`, version: "1.0.0", minAppVersion: "1.0.0",
                description: "A plugin with a longer description to check mobile wrapping, scrolling and access to its loading mode.",
                author: "Mobile UI test", isDesktopOnly: false,
            }));
            await app.vault.adapter.write(`${dir}/main.js`, 'module.exports = class extends require("obsidian").Plugin {};');
        }
        await (app.plugins as unknown as { loadManifests: () => Promise<void> }).loadManifests();
    });

    const settingsPage = await openPluginManagement(obsidian.page);
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await settingsPage.evaluate(() => {
        document.body.classList.remove("theme-light");
        document.body.classList.add("theme-dark");
    });
    await expect(settingsPage.locator(".lazy-plugin-results-count")).toHaveText("37 plugins");
    await settingsPage.waitForTimeout(500);
    await settingsPage.screenshot({ path: path.join(outDir, "many-desktop.png"), animations: "disabled" });

    const compactToggle = settingsPage.locator(".lazy-plugin-compact-control .checkbox-container");
    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await settingsPage.waitForTimeout(400);
    await settingsPage.screenshot({ path: path.join(outDir, "many-desktop-compact.png"), animations: "disabled" });
    await compactToggle.click();

    await settingsPage.evaluate(() => {
        document.body.classList.add("is-mobile", "is-phone", "is-android");
    });
    await settingsPage.setViewportSize({ width: 390, height: 844 });
    await settingsPage.waitForTimeout(600);
    await settingsPage.screenshot({ path: path.join(outDir, "many-mobile.png"), animations: "disabled" });

    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await settingsPage.waitForTimeout(400);
    await settingsPage.screenshot({ path: path.join(outDir, "many-mobile-compact.png"), animations: "disabled" });
    await compactToggle.click();
});
