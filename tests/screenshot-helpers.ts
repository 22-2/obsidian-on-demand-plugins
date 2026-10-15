import type { Page } from "@playwright/test";
import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import path from "node:path";
import { expect } from "./fixtures";
import { pluginUnderTestId } from "./test-utils";

export const FIXTURE_PLUGIN_COUNT = 36;

export function fixturePluginId(index: number): string {
    return `mobile-ui-fixture-${String(index).padStart(2, "0")}`;
}

/**
 * Installs small inert plugins in the isolated vault, so the real registry, list pagination and
 * scroll container are exercised without large downloads.
 */
export async function seedFixturePlugins(obsidian: ObsidianAPI, count = FIXTURE_PLUGIN_COUNT): Promise<void> {
    await obsidian.page.evaluate(async (total) => {
        for (let index = 1; index <= total; index++) {
            const number = String(index).padStart(2, "0");
            const id = `mobile-ui-fixture-${number}`;
            const dir = `${app.vault.configDir}/plugins/${id}`;
            await app.vault.adapter.mkdir(dir);
            await app.vault.adapter.write(
                `${dir}/manifest.json`,
                JSON.stringify({
                    id,
                    name: `Mobile fixture ${number}`,
                    version: "1.0.0",
                    minAppVersion: "1.0.0",
                    description: "A plugin with a longer description to check mobile wrapping, scrolling and access to its loading mode.",
                    author: "Mobile UI test",
                    isDesktopOnly: false,
                }),
            );
            await app.vault.adapter.write(`${dir}/main.js`, 'module.exports = class extends require("obsidian").Plugin {};');
        }
        await (app.plugins as unknown as { loadManifests: () => Promise<void> }).loadManifests();
    }, count);
}

export async function capturePage(page: Page, file: string): Promise<Buffer> {
    await page.evaluate(() => document.fonts.ready);
    return page.screenshot({ path: file, animations: "disabled" });
}

export function openPluginManagement(obsidian: ObsidianAPI): Promise<Page> {
    return obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
}

export async function toggleCompactList(page: Page): Promise<void> {
    await page.locator(".lazy-plugin-compact-control .checkbox-container").click();
}

export async function expectCompactList(page: Page): Promise<void> {
    await expect(page.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
}

export async function openReviewModal(obsidian: ObsidianAPI, settingsPage: Page, buttonName: "Review & save…" | "Discard…"): Promise<Page> {
    await settingsPage.getByRole("button", { name: buttonName, exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await obsidian.waitForAnimations(reviewPage);
    return reviewPage;
}

export async function cancelReviewModal(reviewPage: Page): Promise<void> {
    await reviewPage.locator(".lazy-review-changes-modal .modal-button-container").getByRole("button", { name: "Cancel", exact: true }).click();
}

export function readmeOutDir(): string {
    return process.env.README_SHOT_DIR ?? path.resolve(".ci-artifacts/ui-screenshots/readme");
}
