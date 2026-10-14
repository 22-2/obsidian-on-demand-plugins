import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { pluginUnderTestId, useOnDemandPlugins } from "../../tests/test-utils";

// Captures the review dialog with many pending changes, on desktop and phone. Run with `pnpm readme:shots`.
const outDir = process.env.README_SHOT_DIR ?? path.resolve(".ci-artifacts/ui-screenshots/readme");

useOnDemandPlugins();

test("many pending changes in the review modal", async ({ obsidian }) => {
    await mkdir(outDir, { recursive: true });

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

    // Stage a mode change for every fixture plugin so the review lists them all.
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate(async (instance) => {
        for (let index = 1; index <= 36; index++) {
            const number = String(index).padStart(2, "0");
            await instance.updatePluginSettings(`mobile-ui-fixture-${number}`, index % 2 === 0 ? "lazy" : "lazyOnLayoutReady");
        }
    });

    // The dialog has to fit the window, so the Save and Cancel buttons stay on screen.
    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    await settingsPage.setViewportSize({ width: 900, height: 680 });
    await obsidian.setTheme("dark", settingsPage);
    await expect(settingsPage.locator(".lazy-plugin-save-controls")).toContainText("unsaved change");
    await obsidian.waitForAnimations(settingsPage);

    await settingsPage.getByRole("button", { name: "Review & save…", exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await obsidian.waitForAnimations(reviewPage);
    await reviewPage.screenshot({ path: path.join(outDir, "many-changes-review-desktop.png"), animations: "disabled" });

    await reviewPage.setViewportSize({ width: 390, height: 844 });
    await obsidian.emulateMobile("phone", reviewPage);
    await obsidian.waitForAnimations(reviewPage);
    await reviewPage.screenshot({ path: path.join(outDir, "many-changes-review-mobile.png"), animations: "disabled" });
});
