import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

async function waitForMobileAnimations(page: Page): Promise<void> {
    // Bottom-sheet and page transitions temporarily move the background list;
    // measure settled coordinates so animation frames do not look like scroll jumps.
    await page.waitForFunction(() => document.getAnimations().every((animation) =>
        animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity,
    ));
}

async function openMobilePluginManagement(page: Page): Promise<Page> {
    // Desktop Obsidian opens a separate Settings window; apply mobile classes there
    // so screenshots exercise Obsidian's mobile Setting styles rather than just a narrow desktop.
    const settingsPagePromise = page.context().waitForEvent("page");
    await page.evaluate(() => {
        app.setting.open();
        app.setting.openTabById("on-demand-plugins");
    });
    const settingsPage = await settingsPagePromise;
    await settingsPage.waitForLoadState("domcontentloaded");
    await settingsPage.evaluate(() => {
        document.body.classList.add("is-mobile", "is-phone", "is-android");
    });
    await settingsPage.getByText("Plugin management", { exact: true }).click();
    return settingsPage;
}

test("mobile plugin management remains usable at phone and tablet widths", async ({ obsidian }, testInfo) => {
    if (!ensureBuilt()) return;
    await obsidian.waitReady();
    const plugin = await obsidian.plugin(pluginUnderTestId);
    // The longest mode label exposes wrapping and dropdown overflow at narrow widths.
    await plugin.evaluate((instance, id) => instance.updatePluginSettings(id, "lazyOnLayoutReady"), targetPluginId);
    const page = await openMobilePluginManagement(obsidian.page);
    const artifactDir = path.resolve(".ci-artifacts/mobile-ui");
    await mkdir(artifactDir, { recursive: true });

    for (const width of [390, 320, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        const input = page.locator(".lazy-plugin-filter-row input");
        const row = page.locator(".lazy-plugin-mode-row");
        for (const query of ["BRAT ", "  bRaT  ", "   "]) {
            await input.fill(query);
            await expect(row).toHaveCount(1);
            // Normalizing matching must not rewrite what the user is still typing.
            await expect(input).toHaveValue(query);
        }
        await input.fill("BRAT");
        // Obsidian creates a hidden select to measure mobile labels; target the interactive combobox.
        await page.locator(".lazy-plugin-filter-row").getByRole("combobox").selectOption("lazyOnLayoutReady");
        await expect(row).toHaveCount(1);
        await row.scrollIntoViewIfNeeded();
        const screenshotPath = path.join(artifactDir, `mobile-${width}.png`);
        await page.screenshot({ path: screenshotPath, animations: "disabled" });
        await testInfo.attach(`mobile-${width}`, { path: screenshotPath, contentType: "image/png" });

        const actions = row.getByRole("button", { name: "Actions", exact: true });
        await expect(actions).toBeVisible();
        await expect(row.locator(".lazy-plugin-row-actions-desktop")).toBeHidden();
        const bounds = await row.evaluate((el) => {
            const button = el.querySelector(".lazy-plugin-row-actions-mobile")!;
            const info = el.querySelector(".setting-item-info")!;
            const r = el.getBoundingClientRect();
            const b = button.getBoundingClientRect();
            return {
                width: b.width, height: b.height, rightGap: r.right - b.right,
                belowDescription: b.top >= info.getBoundingClientRect().bottom,
                fits: el.scrollWidth <= el.clientWidth && r.left >= 0 && r.right <= window.innerWidth,
            };
        });
        expect(bounds.width).toBeGreaterThanOrEqual(112);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.rightGap).toBeLessThanOrEqual(17);
        expect(bounds.belowDescription).toBe(true);
        expect(bounds.fits).toBe(true);
        await page.locator(".lazy-plugin-filter-row").getByRole("combobox").selectOption("");
    }

    // Exercise the visible native button and the real shared menu, rather than calling its handler directly.
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.locator(".lazy-plugin-mode-row");
    await row.getByRole("button", { name: "Actions", exact: true }).click();
    const menuPage = await Promise.any(page.context().pages().map(async (candidate) => {
        await candidate.locator(".menu-item").filter({ hasText: "🤲 Lazy on demand" }).waitFor({ state: "visible" });
        return candidate;
    }));
    await menuPage.locator(".menu-item").filter({ hasText: "🤲 Lazy on demand" }).click();
    await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🤲 Lazy on demand");
    await expect(page.getByRole("button", { name: "Save & apply (1)", exact: true })).toBeEnabled();
});

for (const width of [320, 390]) {
    test(`mobile ${width}px Actions menu and pinned save controls in a long plugin list`, async ({ obsidian }, testInfo) => {
        if (!ensureBuilt()) return;
        test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");
        await obsidian.waitReady();
        // Install small inert plugins in the isolated vault so the real registry,
        // list pagination and scroll container are exercised without large downloads.
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
        const page = await openMobilePluginManagement(obsidian.page);
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await expect(page.locator(".lazy-plugin-results-count")).toHaveText("37 plugins");
        await expect(page.locator(".lazy-plugin-save-controls")).toHaveCount(0);
        const row = page.locator(".lazy-plugin-mode-row").filter({ has: page.getByText("Mobile fixture 18", { exact: true }) });
        await row.scrollIntoViewIfNeeded();
        await row.getByRole("button", { name: "Actions", exact: true }).click();
        const menu = page.locator(".menu").filter({ has: page.getByText("🤲 Lazy on demand", { exact: true }) });
        await expect(menu).toBeVisible();
        await waitForMobileAnimations(page);
        expect(await menu.evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight;
        })).toBe(true);

        const artifactDir = path.resolve(".ci-artifacts/mobile-ui");
        await mkdir(artifactDir, { recursive: true });
        const capture = async (state: string) => {
            const screenshotPath = path.join(artifactDir, `mobile-${width}-${state}.png`);
            await page.screenshot({ path: screenshotPath, animations: "disabled" });
            await testInfo.attach(`mobile-${width}-${state}`, { path: screenshotPath, contentType: "image/png" });
        };
        await capture("actions-menu");
        // Opening the menu can scroll the button into view; compare against the row's settled position.
        const beforeTop = (await row.boundingBox())!.y;
        await menu.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" }).click();
        await expect(row.locator(".lazy-plugin-mode-badge")).toHaveText("🚀 Lazy on layout ready");
        await expect(page.getByRole("button", { name: "Save & apply (1)", exact: true })).toBeEnabled();
        // Prepending the pending bar must preserve the row being edited instead of jumping to the top.
        await waitForMobileAnimations(page);
        await expect.poll(async () => Math.abs((await row.boundingBox())!.y - beforeTop)).toBeLessThanOrEqual(2);

        const sticky = page.locator(".lazy-plugin-save-controls");
        const pinnedBounds = () => sticky.evaluate((bar) => {
            let scroller = bar.parentElement!;
            while (scroller.parentElement && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
                scroller = scroller.parentElement;
            }
            return {
                position: getComputedStyle(bar).position,
                scrollTop: scroller.scrollTop,
                // Mobile Settings reserves padding for the header inside the scrollport.
                expectedGap: parseFloat(getComputedStyle(scroller).paddingTop) + parseFloat(getComputedStyle(bar).top),
                topGap: bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop,
            };
        });
        await expect.poll(async () => (await pinnedBounds()).position).toBe("sticky");
        expect((await pinnedBounds()).scrollTop).toBeGreaterThan(500);
        await expect.poll(async () => {
            const bounds = await pinnedBounds();
            return Math.abs(bounds.topGap - bounds.expectedGap);
        }).toBeLessThanOrEqual(1);
        await capture("changed-pinned");

        // Move farther down after editing, exercising infinite scrolling with the save bar still pinned.
        await row.hover();
        const previousScrollTop = (await pinnedBounds()).scrollTop;
        await page.mouse.wheel(0, 1800);
        await expect.poll(async () => (await pinnedBounds()).scrollTop - previousScrollTop).toBeGreaterThan(500);
        await expect.poll(() => page.locator(".lazy-plugin-mode-row").count()).toBeGreaterThan(24);
        await expect.poll(async () => {
            const bounds = await pinnedBounds();
            return Math.abs(bounds.topGap - bounds.expectedGap);
        }).toBeLessThanOrEqual(1);
        await expect(page.getByRole("button", { name: "Save & apply (1)", exact: true })).toBeInViewport();
        await capture("scrolled-pinned");

        const nextRow = page.locator(".lazy-plugin-mode-row").filter({ has: page.getByText("Mobile fixture 30", { exact: true }) });
        await nextRow.scrollIntoViewIfNeeded();
        await nextRow.getByRole("button", { name: "Actions", exact: true }).click();
        await expect(menu).toBeVisible();
        await waitForMobileAnimations(page);
        await capture("scrolled-pinned-actions-menu");
        const nextTop = (await nextRow.boundingBox())!.y;
        await menu.locator(".menu-item").filter({ hasText: "✅ Always enabled" }).click();
        await waitForMobileAnimations(page);
        await expect(nextRow.locator(".lazy-plugin-mode-badge")).toHaveText("✅ Always enabled");
        await expect(page.getByRole("button", { name: "Save & apply (2)", exact: true })).toBeInViewport();
        await expect.poll(async () => Math.abs((await nextRow.boundingBox())!.y - nextTop)).toBeLessThanOrEqual(2);
        await capture("scrolled-pinned-second-change");
    });
}
