import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

type TablePlugin = { openPluginTable: () => Promise<void>; getPluginMode: (id: string) => string; updatePluginSettings: (id: string, mode: string) => Promise<void> };

async function startFrom(obsidian: ObsidianAPI, mode: string) {
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance, [id, next]) => (instance as unknown as TablePlugin).updatePluginSettings(id, next), [targetPluginId, mode] as const);
    return plugin;
}

async function startUnloadedAndUnsaved(obsidian: ObsidianAPI) {
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.disablePlugin(id);
        app.plugins.enabledPlugins.delete(id);
        const saved = await app.vault.readConfigJson("community-plugins");
        if (!Array.isArray(saved)) throw new Error("Invalid community plugins configuration");
        await app.vault.writeConfigJson("community-plugins", saved.filter((value: unknown) => value !== id));
    }, targetPluginId);
}

async function openTable(obsidian: ObsidianAPI) {
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await expect(view).toBeVisible();
    await view.getByRole("textbox", { name: "Name", exact: true }).fill("BRAT");
    const row = view.locator("tbody tr").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    return { view, row };
}

function modeOf(obsidian: ObsidianAPI) {
    return obsidian.page.evaluate((id) => (app.plugins.plugins["on-demand-plugins"] as unknown as TablePlugin).getPluginMode(id), targetPluginId);
}

test("plugin table stages a mode from its column and saves it through the shared review", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const { view, row } = await openTable(obsidian);

    const gear = row.locator(".lazy-plugin-table-mode-cell .clickable-icon");
    await expect(gear).toBeVisible();
    await row.getByRole("combobox", { name: /^Mode / }).selectOption("lazyOnLayoutReady");

    // The lazy options apply only to Lazy on demand, so the gear hides but keeps its place.
    await expect(gear).toBeHidden();
    const pending = view.locator(".lazy-plugin-table-pending");
    await expect(pending).toContainText("1 unsaved change · 1 plugin");
    // The table never toggles plugins, so nothing is saved until the review.
    expect(await modeOf(obsidian)).toBe("lazyOnLayoutReady");

    // Applying policies normally reloads Obsidian; intercept only that reload so the saved state can be inspected.
    const reload = await obsidian.interceptReload();
    await pending.getByRole("button", { name: "Review & save…", exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    const review = reviewPage.locator(".lazy-review-changes-modal");
    await expect(review.getByText("🚀 Lazy on layout ready", { exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Save & apply (1)", exact: true }).click();

    await expect(pending.getByRole("button")).toHaveCount(0);
    await expect.poll(() => reload.requested()).toBe(true);
    await reload.restore();
    expect(await modeOf(obsidian)).toBe("lazyOnLayoutReady");
});

test("closing the plugin table sets its draft aside and offers it back on reopen", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const { row } = await openTable(obsidian);
    await row.getByRole("combobox", { name: /^Mode / }).selectOption("alwaysDisabled");

    await obsidian.page.evaluate(() => app.workspace.getLeavesOfType("on-demand-plugin-table").forEach((leaf) => leaf.detach()));
    // Until the user decides, On-Demand runs on the saved settings.
    await expect.poll(() => modeOf(obsidian)).toBe("lazy");

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    const restorePage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal").filter({ hasText: "Restore unsaved changes" }), { timeout: 10_000 });
    await restorePage.getByRole("button", { name: "Restore (1)", exact: true }).click();

    await expect.poll(() => modeOf(obsidian)).toBe("alwaysDisabled");
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await view.getByRole("textbox", { name: "Name", exact: true }).fill("BRAT");
    await expect(view.locator("tbody tr").filter({ hasText: "BRAT" }).getByRole("combobox", { name: /^Mode / })).toHaveValue("alwaysDisabled");
    await expect(view.locator(".lazy-plugin-table-pending")).toContainText("1 unsaved change");
});

test("plugin table switches to the touch layout on phones", async ({ obsidian }, testInfo) => {
    await startFrom(obsidian, "lazy");
    // Mobile classes must be in place before the view opens, since the table picks its layout when it is built.
    await obsidian.emulateMobile("phone");
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    // Obsidian's mobile styles hide the desktop workspace under emulation, so this checks the built layout, not its pixels.
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    const row = view.locator("tbody tr").filter({ hasText: "BRAT" });
    await expect(row).toHaveCount(1);
    // Mobile Obsidian hides workspace tabs for its native bottom navigation. Expose this active pane
    // in a phone-sized frame so the browser screenshot captures the actual touch layout.
    await obsidian.page.addStyleTag({ content: ".workspace-tabs.mod-active { display: flex !important; position: fixed; inset: 0; z-index: 9999; width: 390px !important; height: 844px !important; }" });
    const wrapper = view.locator(".lazy-plugin-table-wrapper");
    await expect.poll(() => wrapper.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(24);
    await expect(view.locator("thead .lazy-plugin-table-col-description")).toHaveCount(0);
    const modeIcon = row.locator(".lazy-plugin-table-col-mode .lazy-plugin-table-phone-icon-control");
    const loadedIcon = row.locator(".lazy-plugin-table-col-loaded .lazy-plugin-table-phone-icon-control");
    await expect(modeIcon).toHaveAttribute("aria-label", /^🤲 Lazy on demand: BRAT$/);
    await expect(loadedIcon).toHaveAttribute("aria-label", /^Not loaded: BRAT$/);
    const screenshotPath = path.resolve(".ci-artifacts/ui-screenshots/plugin-table/mobile-after.png");
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await view.screenshot({ path: screenshotPath, animations: "disabled" });
    await testInfo.attach("Plugin table on phone after responsive sizing", { path: screenshotPath, contentType: "image/png" });

    // Phones hide the long text columns at first so the name and mode fit.
    await expect(view.locator("thead .lazy-plugin-table-col-author")).toHaveCount(0);
    await expect(view.locator("thead .lazy-plugin-table-col-description")).toHaveCount(0);
    // Touch screens have no right-click, so each row gets a menu button.
    const actions = row.locator(".lazy-plugin-table-col-actions .clickable-icon");
    await expect(actions).toHaveCount(1);
    await expect.poll(() => actions.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);

    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");
    await modeIcon.click();
    const nextMode = obsidian.page.locator(".menu-item").filter({ hasText: "🚀 Lazy on layout ready" });
    await expect(nextMode).toHaveCount(1);
    await nextMode.click();
    await expect(modeIcon).toHaveAttribute("aria-label", /^🚀 Lazy on layout ready: BRAT$/);
    await loadedIcon.click();
    const offState = obsidian.page.locator(".menu-item").filter({ hasText: "Off" });
    await expect(offState).toHaveCount(1);
    await offState.click();
    await expect(loadedIcon).toHaveAttribute("aria-label", /^Not loaded: BRAT$/);
    await actions.click();
    await expect(obsidian.page.locator(".menu-item").filter({ hasText: "Show in community plugins" })).toHaveCount(1);
    const menuScreenshotPath = path.resolve(".ci-artifacts/ui-screenshots/plugin-table/mobile-actions-menu.png");
    await obsidian.page.screenshot({ path: menuScreenshotPath, animations: "disabled" });
    await testInfo.attach("Plugin row actions on phone", { path: menuScreenshotPath, contentType: "image/png" });
});

test("opening the table from plugin management keeps the draft live", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const settingsPage = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    // Stage the edit the way the settings list does, so the draft exists before the table opens.
    await obsidian.page.evaluate((id) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as unknown as { settings: { plugins: Record<string, unknown> }; settingsTab: { markDirty: () => void } };
        plugin.settings.plugins[id] = { mode: "alwaysDisabled", userConfigured: true };
        plugin.settingsTab.markDirty();
    }, targetPluginId);

    await settingsPage.getByRole("button", { name: "Open table", exact: true }).click();

    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await expect(view).toBeVisible();
    await view.getByRole("textbox", { name: "Name", exact: true }).fill("BRAT");
    await expect(view.locator("tbody tr").filter({ hasText: "BRAT" }).getByRole("combobox", { name: /^Mode / })).toHaveValue("alwaysDisabled");
    await expect(view.locator(".lazy-plugin-table-pending")).toContainText("1 unsaved change");
    // The table stayed open while settings closed, so the draft was never set aside.
    await expect(obsidian.page.locator(".lazy-review-changes-modal")).toHaveCount(0);
    expect(await modeOf(obsidian)).toBe("alwaysDisabled");
});

test("plugin table lists On-Demand itself as always loaded, without a mode to change", async ({ obsidian }) => {
    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate((instance) => (instance as unknown as TablePlugin).openPluginTable());
    const view = obsidian.page.locator(".lazy-plugin-table-view");
    await view.getByRole("textbox", { name: "Name", exact: true }).fill("On-Demand");
    const row = view.locator("tbody tr").filter({ hasText: "On-Demand" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-table-col-loaded")).toHaveText("Persistent");
    await expect(row.locator(".lazy-plugin-table-lamp.is-loaded")).toHaveCount(1);
    await expect(row.locator(".lazy-plugin-table-lamp.is-memory-only")).toHaveCount(0);
    await expect(row.locator(".lazy-plugin-table-mode-fixed")).toHaveText("✅ Always enabled");
    await expect(row.getByRole("combobox")).toHaveCount(0);
});

test("load a lazy plugin in memory, unload it, and keep the startup setting unchanged", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    await startUnloadedAndUnsaved(obsidian);
    const { view, row } = await openTable(obsidian);
    const loaded = row.getByRole("combobox", { name: /^Loaded / });
    await expect(loaded).toBeEnabled();
    await expect(loaded).toHaveValue("off");
    await expect(loaded.locator("option[value=saved]")).toHaveCount(0);
    await loaded.selectOption("memory");
    await expect.poll(() => obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), targetPluginId)).toBe(true);
    await expect(loaded).toHaveValue("memory");
    await expect.poll(() => obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), targetPluginId)).toBe(true);
    expect(await obsidian.page.evaluate(async (id) => (await app.vault.readConfigJson("community-plugins") as string[]).includes(id), targetPluginId)).toBe(false);
    await expect(view.locator(".lazy-plugin-table-pending button")).toHaveCount(0);

    await loaded.selectOption("off");
    await expect(loaded).toHaveValue("off");
    await expect.poll(() => obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), targetPluginId)).toBe(false);
    expect(await modeOf(obsidian)).toBe("lazy");
});

test("a staged mode cannot persist an in-memory plugin before review and discard restores its choices", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    await startUnloadedAndUnsaved(obsidian);
    const { view, row } = await openTable(obsidian);
    const loaded = row.getByRole("combobox", { name: /^Loaded / });
    await expect(loaded).toBeEnabled();
    await loaded.selectOption("memory");
    await expect(loaded).toHaveValue("memory");
    await row.getByRole("combobox", { name: /^Mode / }).selectOption("alwaysEnabled");

    await expect(loaded).toHaveValue("memory");
    await expect(loaded.locator("option[value=memory]")).toHaveAttribute("hidden", "");
    await expect(loaded.locator("option[value=saved]")).toHaveCount(0);
    expect(await obsidian.page.evaluate(async (id) => (await app.vault.readConfigJson("community-plugins") as string[]).includes(id), targetPluginId)).toBe(false);

    await view.getByRole("button", { name: "Discard…", exact: true }).click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"), { timeout: 10_000 });
    await reviewPage.locator(".lazy-review-changes-modal").getByRole("button", { name: /Discard/ }).click();
    await expect.poll(() => modeOf(obsidian)).toBe("lazy");
    await expect(loaded).toHaveValue("memory");
    await expect(loaded.locator("option[value=memory]")).not.toHaveAttribute("hidden", "");
});

test("temporarily unloading a persistent plugin leaves it enabled after restarting", async ({ obsidian }) => {
    await startFrom(obsidian, "alwaysEnabled");
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.enablePlugin(id);
        app.plugins.enabledPlugins.add(id);
        const saved = await app.vault.readConfigJson("community-plugins");
        if (!Array.isArray(saved)) throw new Error("Invalid community plugins configuration");
        await app.vault.writeConfigJson("community-plugins", [...new Set([...saved, id])]);
    }, targetPluginId);
    const { row } = await openTable(obsidian);
    const loaded = row.getByRole("combobox", { name: /^Loaded / });
    await expect(loaded).toBeEnabled();
    await expect(loaded).toHaveValue("saved");
    await expect(loaded.locator("option[value=memory]")).toHaveCount(0);
    await loaded.selectOption("off");
    await expect(loaded).toHaveValue("off");
    await expect.poll(() => obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), targetPluginId)).toBe(false);
    expect(await obsidian.page.evaluate(async (id) => (await app.vault.readConfigJson("community-plugins") as string[]).includes(id), targetPluginId)).toBe(true);

    await obsidian.reload({ expectLoaded: [pluginUnderTestId, targetPluginId] });
    const reopened = await openTable(obsidian);
    await expect(reopened.row.getByRole("combobox", { name: /^Loaded / })).toHaveValue("saved");
});

test("a lazy plugin saved externally can be changed to in-memory loading", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    await obsidian.page.evaluate(async (id) => {
        await app.plugins.enablePlugin(id);
        app.plugins.enabledPlugins.add(id);
        const saved = await app.vault.readConfigJson("community-plugins");
        if (!Array.isArray(saved)) throw new Error("Invalid community plugins configuration");
        await app.vault.writeConfigJson("community-plugins", [...new Set([...saved, id])]);
    }, targetPluginId);
    const { row } = await openTable(obsidian);
    const loaded = row.getByRole("combobox", { name: /^Loaded / });
    await expect(loaded).toBeEnabled();
    await expect(loaded).toHaveValue("saved");
    await loaded.selectOption("memory");
    await expect.poll(() => obsidian.page.evaluate(async (id) => (await app.vault.readConfigJson("community-plugins") as string[]).includes(id), targetPluginId)).toBe(false);
    await expect(loaded).toHaveValue("memory");
    expect(await modeOf(obsidian)).toBe("lazy");
});

test("an already loaded plugin can become persistent without a restart", async ({ obsidian }) => {
    await startFrom(obsidian, "alwaysEnabled");
    await startUnloadedAndUnsaved(obsidian);
    await obsidian.page.evaluate((id) => app.plugins.enablePlugin(id), targetPluginId);
    const { row } = await openTable(obsidian);
    const loaded = row.getByRole("combobox", { name: /^Loaded / });
    await expect(loaded).toBeEnabled();
    await expect(loaded).toHaveValue("memory");
    await loaded.selectOption("saved");
    await expect(loaded).toHaveValue("saved");
    await expect.poll(() => obsidian.page.evaluate(async (id) => (await app.vault.readConfigJson("community-plugins") as string[]).includes(id), targetPluginId)).toBe(true);
    expect(await modeOf(obsidian)).toBe("alwaysEnabled");
});

test("filtering to no results and clearing it preserves the staged edit", async ({ obsidian }) => {
    await startFrom(obsidian, "lazy");
    const { view, row } = await openTable(obsidian);
    await row.getByRole("combobox", { name: /^Mode / }).selectOption("alwaysDisabled");
    const filter = view.getByRole("textbox", { name: "Name", exact: true });
    await filter.fill("not-a-real-plugin-🚀-".repeat(20));
    await expect(view.locator("tbody tr").filter({ hasText: "BRAT" })).toHaveCount(0);
    await expect(view.locator(".lazy-plugin-table-pending")).toContainText("1 unsaved change");
    await filter.fill("BRAT");
    await expect(row.getByRole("combobox", { name: /^Mode / })).toHaveValue("alwaysDisabled");
    expect(await modeOf(obsidian)).toBe("alwaysDisabled");
});
