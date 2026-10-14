import type { LazySettings } from "src/core/types";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

test("ordinary settings and profiles save immediately without committing or discarding a plugin draft", async ({ obsidian }) => {
    test.skip(process.platform === "darwin", "The native macOS menu is unavailable to Playwright DOM locators.");
    await (await obsidian.plugin(pluginUnderTestId)).evaluate((instance, id) => instance.updatePluginSettings(id, "alwaysEnabled"), targetPluginId);
    await obsidian.reloadPlugin(pluginUnderTestId);
    const plugin = await obsidian.plugin(pluginUnderTestId);
    const readSaved = () => plugin.evaluate(async (instance): Promise<LazySettings> => JSON.parse(await app.vault.adapter.read(`${instance.manifest.dir}/data.json`)));
    const profileId = await plugin.evaluate((instance) => instance.core.settingsService.currentProfileId);
    const original = await readSaved();
    const savedMode = original.profiles[profileId].settings.plugins[targetPluginId].mode;
    const stagedLabel = savedMode === "lazy" ? "✅ Always enabled" : "🤲 Lazy on demand";
    const page = await obsidian.openSettings(pluginUnderTestId, { subPage: "Plugin management" });
    const row = page.locator(".lazy-plugin-mode-row").filter({ hasText: "BRAT" });
    await row.locator(".lazy-plugin-row-actions-desktop").click();
    const menuPage = await obsidian.findPage((candidate) => candidate.locator(".menu-item").filter({ hasText: stagedLabel }));
    await menuPage.locator(".menu-item").filter({ hasText: stagedLabel }).click();
    await expect(page.locator(".lazy-plugin-save-controls")).toBeVisible();

    const behaviour = await obsidian.openSettings(pluginUnderTestId, { subPage: "Behaviour" });
    const nextDefault = original.profiles[profileId].settings.defaultMode === "lazy" ? "lazyOnLayoutReady" : "lazy";
    await behaviour.locator(".setting-item").filter({ hasText: "Default mode for newly discovered plugins." }).getByRole("combobox").selectOption(nextDefault);
    await expect.poll(async () => (await readSaved()).profiles[profileId].settings.defaultMode).toBe(nextDefault);
    await expect(behaviour.locator(".lazy-plugin-save-controls")).toHaveCount(0);
    expect((await readSaved()).profiles[profileId].settings.plugins[targetPluginId].mode).toBe(savedMode);

    const profiles = await obsidian.openSettings(pluginUnderTestId, { subPage: "Profile management" });
    await profiles.locator(".setting-item").filter({ hasText: "New profiles start with the default settings." }).getByRole("textbox").fill("Autosaved profile");
    await profiles.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(async () => Object.values((await readSaved()).profiles).some((profile) => profile.name === "Autosaved profile")).toBe(true);
    await expect(profiles.locator(".lazy-plugin-save-controls")).toHaveCount(0);

    const maintenance = await obsidian.openSettings(pluginUnderTestId, { subPage: "Maintenance & batch" });
    await maintenance.locator(".lazy-maintenance-advanced > summary").click();
    await maintenance.locator(".setting-item").filter({ hasText: "Debug log output" }).locator(".checkbox-container").click();
    await expect.poll(async () => (await readSaved()).showConsoleLog).toBe(!original.showConsoleLog);
    expect((await readSaved()).profiles[profileId].settings.plugins[targetPluginId].mode).toBe(savedMode);
    // Discard affects only the outstanding draft; immediate saves must survive the reload from disk.
    await maintenance.getByRole("button", { name: "Discard…", exact: true }).click();
    const discardPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"));
    await discardPage.getByRole("button", { name: /^Discard all/ }).click();
    await expect(maintenance.locator(".lazy-plugin-save-controls")).toHaveCount(0);
    expect(await plugin.evaluate((instance, id) => instance.getPluginMode(id), targetPluginId)).toBe(savedMode);
    const saved = await readSaved();
    expect(saved.profiles[profileId].settings.defaultMode).toBe(nextDefault);
    expect(saved.showConsoleLog).toBe(!original.showConsoleLog);
    expect(Object.values(saved.profiles).some((profile) => profile.name === "Autosaved profile")).toBe(true);
});

test("advanced batch edits and config imports remain staged until reviewed", async ({ obsidian }) => {
    await (await obsidian.plugin(pluginUnderTestId)).evaluate((instance, id) => instance.updatePluginSettings(id, "alwaysEnabled"), targetPluginId);
    await obsidian.reloadPlugin(pluginUnderTestId);
    const plugin = await obsidian.plugin(pluginUnderTestId);
    const readSavedMode = () =>
        plugin.evaluate(async (instance, id) => {
            const data = JSON.parse(await app.vault.adapter.read(`${instance.manifest.dir}/data.json`)) as LazySettings;
            return data.profiles[instance.core.settingsService.currentProfileId].settings.plugins[id].mode;
        }, targetPluginId);
    const savedMode = await readSavedMode();
    const targetMode = savedMode === "alwaysDisabled" ? "alwaysEnabled" : "alwaysDisabled";
    const page = await obsidian.openSettings(pluginUnderTestId, { subPage: "Maintenance & batch" });
    const advanced = page.locator(".lazy-maintenance-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await expect(advanced.getByRole("button", { name: "Replace all", exact: true })).toBeHidden();
    // Native details must work from the keyboard as well as by pointer.
    await advanced.locator("summary").focus();
    await advanced.locator("summary").press("Enter");
    await advanced.locator(".setting-item").filter({ hasText: "From mode" }).getByRole("combobox").selectOption(savedMode!);
    await advanced.locator(".setting-item").filter({ hasText: "To mode" }).getByRole("combobox").selectOption(targetMode);
    await advanced.getByRole("button", { name: "Replace all", exact: true }).click();
    await expect(page.locator(".lazy-plugin-save-controls")).toBeVisible();
    await expect(advanced).toHaveAttribute("open", "");
    expect(await readSavedMode()).toBe(savedMode);
    const rebuildReload = await obsidian.interceptReload();
    await page.getByRole("button", { name: "Rebuild caches", exact: true }).click();
    await expect(page.locator(".notice").filter({ hasText: "before rebuilding caches" })).toBeVisible();
    expect(await readSavedMode()).toBe(savedMode);
    expect(await rebuildReload.requested()).toBe(false);
    await rebuildReload.restore();
    await advanced.locator("summary").click();
    const reviewButton = page.getByRole("button", { name: "Review & save…", exact: true });
    await expect(reviewButton).toBeVisible();
    await reviewButton.click();
    const reviewPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"));
    await expect(reviewPage.locator(".lazy-review-changes-item")).toContainText("BRAT");
    expect(await readSavedMode()).toBe(savedMode);
    await reviewPage.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard…", exact: true }).click();
    const discardPage = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"));
    await discardPage.getByRole("button", { name: /^Discard all/ }).click();
    await expect(page.locator(".lazy-plugin-save-controls")).toHaveCount(0);

    // Import the opposite saved enabled state through the real Sync button.
    await obsidian.page.evaluate(
        async ({ id, enable }) => {
            const ids = (await app.vault.readConfigJson("community-plugins")) as string[];
            await app.vault.writeConfigJson("community-plugins", enable ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id));
        },
        { id: targetPluginId, enable: savedMode === "alwaysDisabled" },
    );
    await advanced.locator("summary").click();
    await advanced.locator(".setting-item").filter({ hasText: "Sync direction" }).getByRole("combobox").selectOption("coreToLazy");
    await advanced.getByRole("button", { name: "Sync now", exact: true }).click();
    await expect(page.locator(".lazy-plugin-save-controls")).toBeVisible();
    expect(await readSavedMode()).toBe(savedMode);
    const reload = await obsidian.interceptReload();
    await reviewButton.click();
    const importReview = await obsidian.findPage((candidate) => candidate.locator(".lazy-review-changes-modal"));
    await importReview.getByRole("button", { name: /^Save & apply/ }).click();
    await expect.poll(readSavedMode).toBe(targetMode);
    await expect.poll(() => reload.requested()).toBe(true);
    await reload.restore();
});
