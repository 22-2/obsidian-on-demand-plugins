import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { FIXTURE_PLUGIN_COUNT, cancelReviewModal, capturePage, expectCompactList, fixturePluginId, openPluginManagement, openReviewModal, readmeOutDir, seedFixturePlugins, toggleCompactList } from "./screenshot-helpers";
import { pluginUnderTestId, useOnDemandPlugins, useOnDemandPluginsWithTargets } from "./test-utils";

// README screenshots. Run with `pnpm ui:shots:readme`; README_SHOT_DIR overrides the output folder.
// The well-known plugin names below are what the README pictures show, so keep them here in one place.
// ss.png and ss-modal.png match the existing README asset names for drop-in replacement.
const outDir = readmeOutDir();
const shot = (name: string) => path.join(outDir, name);
const README_PLUGINS = ["obsidian42-brat", "obsidian-excalidraw-plugin", "obsidian-linter", "notebook-navigator"] as const;

test.describe("README: well-known plugins", () => {
    useOnDemandPluginsWithTargets(README_PLUGINS);

    test("capture README screenshots", async ({ obsidian }) => {
        await mkdir(outDir, { recursive: true });

        const plugin = await obsidian.plugin(pluginUnderTestId);
        await plugin.evaluate(async (instance) => {
            await instance.updatePluginSettings("obsidian42-brat", "lazyOnLayoutReady");
            await instance.updatePluginSettings("obsidian-excalidraw-plugin", "lazy");
            instance.core.settingsService.activeProfile.settings.plugins["obsidian-excalidraw-plugin"].lazyOptions = {
                useView: true,
                viewTypes: ["excalidraw"],
                useFile: true,
                fileCriteria: { suffixes: [".excalidraw"], frontmatterKeys: ["excalidraw-plugin"] },
            };
            await instance.updatePluginSettings("obsidian-linter", "alwaysDisabled");
            await instance.updatePluginSettings("notebook-navigator", "lazy");
        });

        const settingsPage = await openPluginManagement(obsidian);
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
        await expect(settingsPage.locator(".lazy-plugin-mode-row")).toHaveCount(README_PLUGINS.length);

        for (const width of [1100, 900, 700]) {
            await settingsPage.setViewportSize({ width, height: 877 });
            await obsidian.waitForAnimations(settingsPage);
            await capturePage(settingsPage, shot(`window-${width}.png`));
        }

        // The OS window is 916px wide; a wider layout is clipped at its right edge, so keep the page within it.
        await settingsPage.setViewportSize({ width: 900, height: 877 });
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("ss.png"));

        const reviewPage = await openReviewModal(obsidian, settingsPage, "Review & save…");
        await capturePage(reviewPage, shot("window-review.png"));
        await cancelReviewModal(reviewPage);

        // Discard: the same staged changes, previewed as what would be lost and restored.
        const discardPage = await openReviewModal(obsidian, settingsPage, "Discard…");
        await capturePage(discardPage, shot("window-discard.png"));
        await cancelReviewModal(discardPage);

        // Compact list: turn the toggle on in a desktop-width window for the one-line view.
        await settingsPage.setViewportSize({ width: 900, height: 877 });
        await obsidian.waitForAnimations(settingsPage);
        await toggleCompactList(settingsPage);
        await expectCompactList(settingsPage);
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("window-compact.png"));
        await toggleCompactList(settingsPage);

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
        await optionsModal.screenshot({ path: shot("ss-modal.png"), animations: "disabled" });
        await optionsModal.getByRole("button", { name: "Cancel", exact: true }).click();

        // Phone layout: the same classes and 390px viewport as the UI screenshots. The OS window cannot shrink
        // this far (it stops at about 616px), so the phone shots are page screenshots rather than window captures.
        await obsidian.emulateMobile("phone", settingsPage);
        await settingsPage.setViewportSize({ width: 390, height: 844 });
        await obsidian.waitForAnimations(settingsPage);
        await settingsPage.screenshot({ path: shot("mobile-settings.png"), animations: "disabled" });

        const mobileReviewPage = await openReviewModal(obsidian, settingsPage, "Review & save…");
        await capturePage(mobileReviewPage, shot("mobile-review.png"));
        await cancelReviewModal(mobileReviewPage);
    });
});

// The long-list shots use inert fixture plugins instead of real ones, so the list is long enough to scroll.
test.describe("README: long plugin list", () => {
    useOnDemandPlugins();

    test("many plugins preview on desktop and phone", async ({ obsidian }) => {
        await mkdir(outDir, { recursive: true });
        await seedFixturePlugins(obsidian);

        const settingsPage = await openPluginManagement(obsidian);
        await settingsPage.setViewportSize({ width: 900, height: 877 });
        await obsidian.setTheme("dark", settingsPage);
        await expect(settingsPage.locator(".lazy-plugin-results-count")).toHaveText(`${FIXTURE_PLUGIN_COUNT + 1} plugins`);
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("many-desktop.png"));

        await toggleCompactList(settingsPage);
        await expectCompactList(settingsPage);
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("many-desktop-compact.png"));
        await toggleCompactList(settingsPage);

        await obsidian.emulateMobile("phone", settingsPage);
        await settingsPage.setViewportSize({ width: 390, height: 844 });
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("many-mobile.png"));

        await toggleCompactList(settingsPage);
        await expectCompactList(settingsPage);
        await obsidian.waitForAnimations(settingsPage);
        await capturePage(settingsPage, shot("many-mobile-compact.png"));
        await toggleCompactList(settingsPage);
    });

    test("many pending changes in the review modal", async ({ obsidian }) => {
        await mkdir(outDir, { recursive: true });
        await seedFixturePlugins(obsidian);

        // Stage a mode change for every fixture plugin so the review lists them all.
        const plugin = await obsidian.plugin(pluginUnderTestId);
        const ids = Array.from({ length: FIXTURE_PLUGIN_COUNT }, (_, i) => fixturePluginId(i + 1));
        await plugin.evaluate(async (instance, pluginIds) => {
            for (const [i, id] of pluginIds.entries()) {
                // Edit the live settings directly: updatePluginSettings saves immediately, which would leave no draft to review.
                instance.core.settingsService.activeProfile.settings.plugins[id] = { ...instance.core.settingsService.activeProfile.settings.plugins[id], mode: (i + 1) % 2 === 0 ? "lazy" : "lazyOnLayoutReady", userConfigured: true };
            }
        }, ids);

        // The dialog has to fit the window, so the Save and Cancel buttons stay on screen.
        const settingsPage = await openPluginManagement(obsidian);
        await settingsPage.setViewportSize({ width: 900, height: 680 });
        await obsidian.setTheme("dark", settingsPage);
        await expect(settingsPage.locator(".lazy-plugin-save-controls")).toContainText("unsaved change");
        await obsidian.waitForAnimations(settingsPage);

        const reviewPage = await openReviewModal(obsidian, settingsPage, "Review & save…");
        await capturePage(reviewPage, shot("many-changes-review-desktop.png"));

        await reviewPage.setViewportSize({ width: 390, height: 844 });
        await obsidian.emulateMobile("phone", reviewPage);
        await obsidian.waitForAnimations(reviewPage);
        await capturePage(reviewPage, shot("many-changes-review-mobile.png"));
    });
});
