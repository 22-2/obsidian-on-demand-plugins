import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { pluginUnderTestId, useOnDemandPlugins } from "../../tests/test-utils";

// Captures a long plugin list on desktop and phone, normal and compact. Run with `pnpm readme:shots`.
const outDir = process.env.README_SHOT_DIR ?? path.join(os.tmpdir(), "readme-screenshots");

useOnDemandPlugins();

test("many plugins preview on desktop and phone", async ({ obsidian }) => {
    await mkdir(outDir, { recursive: true });

    // 36 small inert plugins in the isolated vault, so the list is long enough to scroll.
    await obsidian.page.evaluate(async () => {
        for (let index = 1; index <= 36; index++) {
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
    });

    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.setViewportSize({ width: 900, height: 877 });
    await obsidian.setTheme("dark", settingsPage);
    await expect(settingsPage.locator(".lazy-plugin-results-count")).toHaveText("37 plugins");
    await obsidian.waitForAnimations(settingsPage);
    await settingsPage.screenshot({ path: path.join(outDir, "many-desktop.png"), animations: "disabled" });

    const compactToggle = settingsPage.locator(".lazy-plugin-compact-control .checkbox-container");
    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await obsidian.waitForAnimations(settingsPage);
    await settingsPage.screenshot({ path: path.join(outDir, "many-desktop-compact.png"), animations: "disabled" });
    await compactToggle.click();

    await obsidian.emulateMobile("phone", settingsPage);
    await settingsPage.setViewportSize({ width: 390, height: 844 });
    await obsidian.waitForAnimations(settingsPage);
    await settingsPage.screenshot({ path: path.join(outDir, "many-mobile.png"), animations: "disabled" });

    await compactToggle.click();
    await expect(settingsPage.locator(".lazy-plugin-list-body.is-compact")).toBeVisible();
    await obsidian.waitForAnimations(settingsPage);
    await settingsPage.screenshot({ path: path.join(outDir, "many-mobile-compact.png"), animations: "disabled" });
    await compactToggle.click();
});
