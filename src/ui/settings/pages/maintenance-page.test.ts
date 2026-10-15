import { Notice } from "src/__mocks__/obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { PLUGIN_MODE } from "src/core/types";
import { createPageFixture } from "src/ui/settings/__mocks__/page-fixture";
import { elements, ui } from "src/ui/settings/__mocks__/settings-ui";
import type { UiElement } from "src/ui/settings/__mocks__/settings-ui";
import { MaintenancePage } from "src/ui/settings/pages/maintenance-page";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/confirm-modal", () => ({ showConfirmModal: vi.fn() }));

vi.mock("obsidian", async () => ({
    ...(await import("src/__mocks__/obsidian")),
    ...(await import("src/ui/settings/__mocks__/settings-ui")),
}));

function setup() {
    const feature = {
        rebuildAndApplyCommandCache: vi.fn().mockResolvedValue(undefined),
        // The fixture returns this object for every feature, including the drift check.
        confirmOverwrite: vi.fn().mockResolvedValue(true),
        executeSync: vi.fn().mockResolvedValue({ changed: 0, message: "Already in sync" }),
        buildSyncPreview: vi.fn().mockResolvedValue({ label: "On-Demand → file", summary: "✅ Already in sync", hasChanges: false }),
        applyBatchModeReplace: vi.fn().mockReturnValue(0),
    };
    const fixture = createPageFixture(feature);
    const page = new MaintenancePage(fixture.plugin, fixture.tab);
    page.display();
    const setting = (name: string) => ui.setting(name, page.containerEl as unknown as UiElement);
    /** Clicks the first button of a setting and waits for the work it started in the background. */
    const clickAndSettle = async (name: string) => {
        await setting(name).buttons[0].click();
        await Promise.all([page.rebuilding, page.syncing]);
    };
    return { ...fixture, feature, page, setting, clickAndSettle };
}

describe("MaintenancePage", () => {
    beforeEach(() => {
        ui.reset();
        vi.clearAllMocks();
        Notice.clearMessages();
    });

    it("keeps advanced controls folded and preserves expansion after refreshing pending changes", () => {
        const { page, tabMock, setting } = setup();
        const root = page.containerEl as unknown as UiElement;
        const advanced = elements(root, "lazy-maintenance-advanced")[0];
        expect(advanced.open).toBe(false);
        expect(advanced.contains(setting("Sync direction").settingEl)).toBe(true);
        expect(advanced.contains(setting("To mode").settingEl)).toBe(true);
        expect(advanced.contains(setting("Debug log output").settingEl)).toBe(true);
        const batchNotice = elements(advanced, "lazy-batch-changes-notice")[0];
        expect(batchNotice.children[0].text).toBe("Batch changes apply only after you select save in the review dialog.");
        expect(batchNotice.parent?.children.indexOf(batchNotice)).toBeGreaterThan(batchNotice.parent?.children.indexOf(setting("To mode").settingEl) ?? -1);
        expect(batchNotice.parent?.children.indexOf(batchNotice)).toBeLessThan(batchNotice.parent?.children.indexOf(setting("Debug options").settingEl) ?? -1);
        expect(advanced.contains(setting("Rebuild command and view caches").settingEl)).toBe(false);
        advanced.open = true;
        advanced.dispatch("toggle");
        tabMock.renderPendingControls.mock.calls[0][1]();
        expect(elements(root, "lazy-maintenance-advanced")[0].open).toBe(true);
    });

    it("waits for immediate saves and keeps the rebuild button disabled until rebuilding finishes", async () => {
        const { feature, page, setting, tabMock } = setup();
        const rebuilding = Promise.withResolvers<void>();
        feature.rebuildAndApplyCommandCache.mockReturnValue(rebuilding.promise);
        const button = setting("Rebuild command and view caches").buttons[0];
        await button.click();
        await vi.waitFor(() => expect(button.disabled).toBe(true));
        expect(tabMock.waitForImmediateSaves.mock.invocationCallOrder[0]).toBeLessThan(feature.rebuildAndApplyCommandCache.mock.invocationCallOrder[0]);
        expect(feature.confirmOverwrite.mock.invocationCallOrder[0]).toBeLessThan(feature.rebuildAndApplyCommandCache.mock.invocationCallOrder[0]);
        expect(feature.rebuildAndApplyCommandCache).toHaveBeenCalledWith({ force: true, externalChangesConfirmed: true });
        rebuilding.resolve();
        await page.rebuilding;
        expect(button.disabledHistory).toEqual([true, false]);
        expect(Notice.messages).toContain("Command and view caches rebuilt successfully");
    });

    it("returns from the click handler at once so Obsidian shows no spinner while the confirmation is open", async () => {
        const { feature, page, setting } = setup();
        const answer = Promise.withResolvers<boolean>();
        feature.confirmOverwrite.mockReturnValueOnce(answer.promise);
        const button = setting("Rebuild command and view caches").buttons[0];

        // The click settles while the confirmation is still unanswered.
        await button.click();
        await vi.waitFor(() => expect(feature.confirmOverwrite).toHaveBeenCalled());
        expect(button.disabled).toBe(false);

        answer.resolve(false);
        await page.rebuilding;
        expect(feature.rebuildAndApplyCommandCache).not.toHaveBeenCalled();
        expect(Notice.messages).toEqual([]);
    });

    it("starts one rebuild and one sync however often the buttons are clicked", async () => {
        const { feature, page, setting } = setup();
        const answer = Promise.withResolvers<boolean>();
        feature.confirmOverwrite.mockReturnValueOnce(answer.promise);
        const syncing = Promise.withResolvers<{ changed: number; message: string }>();
        feature.executeSync.mockReturnValueOnce(syncing.promise);
        const rebuild = setting("Rebuild command and view caches").buttons[0];
        const sync = setting("Sync direction").buttons[0];

        await rebuild.click();
        await rebuild.click();
        await sync.click();
        expect(sync.disabled).toBe(true);
        await sync.click();
        answer.resolve(true);
        syncing.resolve({ changed: 0, message: "Already in sync" });
        await Promise.all([page.rebuilding, page.syncing]);

        expect(feature.confirmOverwrite).toHaveBeenCalledTimes(1);
        expect(feature.rebuildAndApplyCommandCache).toHaveBeenCalledTimes(1);
        expect(feature.executeSync).toHaveBeenCalledTimes(1);
        expect(sync.disabled).toBe(false);
    });

    it("shows what writing Obsidian's config changes and writes it only after confirmation", async () => {
        const { feature, clickAndSettle } = setup();
        feature.buildSyncPreview.mockResolvedValue({ label: "On-Demand → file", summary: "➕ Will enable: 1 (alpha)\n", hasChanges: true });
        vi.mocked(showConfirmModal).mockResolvedValueOnce(false).mockResolvedValueOnce(null).mockResolvedValueOnce(true);

        await clickAndSettle("Sync direction");
        await clickAndSettle("Sync direction");
        expect(feature.executeSync).not.toHaveBeenCalled();
        expect(vi.mocked(showConfirmModal).mock.calls[0][1].message).toBe("On-Demand → file\n➕ Will enable: 1 (alpha)\n\ncommunity-plugins.json is rewritten now and Obsidian restarts to apply it. Continue?");

        await clickAndSettle("Sync direction");
        expect(feature.executeSync).toHaveBeenCalledWith("lazyToCore");
    });

    it("syncs without asking when nothing would change or when only staging a draft", async () => {
        const { feature, setting, clickAndSettle } = setup();
        await clickAndSettle("Sync direction");
        await setting("Sync direction").dropdowns[0].change("coreToLazy");
        await clickAndSettle("Sync direction");
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(feature.buildSyncPreview).toHaveBeenCalledTimes(1);
        expect(feature.executeSync.mock.calls).toEqual([["lazyToCore"], ["coreToLazy"]]);
    });

    it("reports a failed sync instead of leaving the rejection unhandled", async () => {
        const { feature, setting, clickAndSettle } = setup();
        feature.executeSync.mockRejectedValueOnce(new Error("write failed"));
        await clickAndSettle("Sync direction");
        expect(setting("Sync direction").buttons[0].disabled).toBe(false);
        expect(Notice.messages).toEqual(["Failed to sync settings. See the console for details."]);
    });

    it("restores the rebuild button after a failure and reports it instead of a success", async () => {
        const { feature, page, setting } = setup();
        feature.rebuildAndApplyCommandCache.mockRejectedValueOnce(new Error("cache failed"));
        const button = setting("Rebuild command and view caches").buttons[0];
        await button.click();
        await page.rebuilding;
        expect(button.disabled).toBe(false);
        expect(Notice.messages).toEqual(["Failed to rebuild command and view caches. See the console for details."]);
    });

    it("blocks rebuilding and exporting while a plugin draft is pending", async () => {
        const { feature, tabMock, clickAndSettle } = setup();
        tabMock.hasPendingChanges = true;
        await clickAndSettle("Rebuild command and view caches");
        await clickAndSettle("Sync direction");
        expect(feature.rebuildAndApplyCommandCache).not.toHaveBeenCalled();
        expect(feature.executeSync).not.toHaveBeenCalled();
        expect(Notice.messages).toEqual(["Review & save or discard pending plugin changes before rebuilding caches.", "Save or discard pending settings before syncing to Obsidian config."]);
    });

    it("ignores maintenance operations when the feature is unavailable", async () => {
        const { feature, pluginMock, page, setting, clickAndSettle } = setup();
        pluginMock.features.get.mockReturnValue(undefined);
        page.display();
        await clickAndSettle("Rebuild command and view caches");
        await clickAndSettle("Sync direction");
        await setting("To mode").buttons[0].click();
        expect(feature.rebuildAndApplyCommandCache).not.toHaveBeenCalled();
        expect(feature.executeSync).not.toHaveBeenCalled();
        expect(feature.applyBatchModeReplace).not.toHaveBeenCalled();
    });

    it.each(["lazyToCore", "coreToLazy"])("leaves pending state untouched when %s has no changes", async (direction) => {
        const { feature, setting, tabMock, clickAndSettle } = setup();
        await setting("Sync direction").dropdowns[0].change(direction);
        await clickAndSettle("Sync direction");
        expect(feature.executeSync).toHaveBeenCalledWith(direction);
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        expect(tabMock.renderPendingControls).toHaveBeenCalledTimes(1);
        expect(Notice.messages).toEqual(["Already in sync"]);
    });

    it("exports saved configuration without staging a draft and restarts Obsidian to apply it", async () => {
        const { feature, pluginMock, tabMock, clickAndSettle } = setup();
        feature.executeSync.mockResolvedValueOnce({ changed: 1, message: "Config updated" });
        await clickAndSettle("Sync direction");
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        expect(tabMock.pendingPluginIds.size).toBe(0);
        expect(pluginMock.app.commands.executeCommandById).toHaveBeenCalledWith("app:reload");
    });

    it("does not restart when the export changed nothing or only staged an import", async () => {
        const { feature, pluginMock, setting, clickAndSettle } = setup();
        await clickAndSettle("Sync direction");
        await setting("Sync direction").dropdowns[0].change("coreToLazy");
        feature.executeSync.mockResolvedValueOnce({ changed: 1, message: "Staged", pluginIds: ["alpha"] });
        await clickAndSettle("Sync direction");
        expect(pluginMock.app.commands.executeCommandById).not.toHaveBeenCalled();
    });

    it.each([true, false])("stages imported changes without overwriting an existing draft (IDs returned: %s)", async (withIds) => {
        const { feature, setting, tabMock, clickAndSettle } = setup();
        tabMock.hasPendingChanges = true;
        tabMock.pendingPluginIds.add("existing");
        feature.executeSync.mockResolvedValueOnce({ changed: 2, message: "Imported", ...(withIds ? { pluginIds: ["alpha", "beta"] } : {}) });
        await setting("Sync direction").dropdowns[0].change("coreToLazy");
        await clickAndSettle("Sync direction");
        expect(tabMock.pendingPluginIds).toEqual(new Set(withIds ? ["existing", "alpha", "beta"] : ["existing"]));
        expect(tabMock.markDirty).toHaveBeenCalledOnce();
        expect(tabMock.saveImmediateChanges).not.toHaveBeenCalled();
        expect(tabMock.renderPendingControls).toHaveBeenCalledTimes(2);
    });

    it("does not claim changes when a batch has no matches or identical modes", async () => {
        const { feature, setting, tabMock, pluginMock } = setup();
        await setting("From mode").dropdowns[0].change(PLUGIN_MODE.ALWAYS_ENABLED);
        await setting("To mode").dropdowns[0].change(PLUGIN_MODE.ALWAYS_ENABLED);
        await setting("To mode").buttons[0].click();
        expect(feature.applyBatchModeReplace).not.toHaveBeenCalled();
        await setting("To mode").dropdowns[0].change(PLUGIN_MODE.LAZY);
        await setting("To mode").buttons[0].click();
        expect(pluginMock.updateManifests).toHaveBeenCalledOnce();
        expect(feature.applyBatchModeReplace).toHaveBeenCalledWith(PLUGIN_MODE.ALWAYS_ENABLED, PLUGIN_MODE.LAZY);
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        expect(Notice.messages).toEqual([]);
    });

    it("stages only matching plugins in a batch and retains earlier staged IDs", async () => {
        const { feature, setting, tabMock } = setup();
        feature.applyBatchModeReplace.mockReturnValueOnce(1);
        tabMock.pendingPluginIds.add("existing");
        await setting("To mode").buttons[0].click();
        expect(feature.applyBatchModeReplace).toHaveBeenCalledWith(PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.LAZY);
        expect(tabMock.pendingPluginIds).toEqual(new Set(["existing", "alpha"]));
        expect(tabMock.markDirty).toHaveBeenCalledOnce();
        expect(tabMock.saveImmediateChanges).not.toHaveBeenCalled();
        expect(Notice.messages).toEqual(["Staged 1 plugin changes. Save to apply them."]);
    });

    it("saves debug output immediately before configuring the logger", async () => {
        const { setting, tabMock, pluginMock, data } = setup();
        await setting("Debug log output").toggles[0].change(true);
        expect(data.showConsoleLog).toBe(true);
        expect(tabMock.saveImmediateChanges.mock.invocationCallOrder[0]).toBeLessThan(pluginMock.configureLogger.mock.invocationCallOrder[0]);
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        expect(setting("Debug log output").toggles[0].value).toBe(true);
    });

    it("does not reconfigure logging or redraw if saving debug output fails", async () => {
        const { setting, tabMock, pluginMock, data } = setup();
        tabMock.saveImmediateChanges.mockRejectedValueOnce(new Error("write failed"));
        await expect(setting("Debug log output").toggles[0].change(true)).rejects.toThrow("write failed");
        expect(data.showConsoleLog).toBe(false);
        expect(pluginMock.configureLogger).not.toHaveBeenCalled();
        expect(tabMock.renderPendingControls).toHaveBeenCalledTimes(1);
    });
});
