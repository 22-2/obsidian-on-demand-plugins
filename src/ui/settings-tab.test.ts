import type { App } from "obsidian";
import { Notice } from "src/__mocks__/obsidian";
import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { showRestoreDraftModal } from "src/ui/modals/review-changes-modal";
import { SettingsTab } from "src/ui/settings-tab";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => ({
    ...(await import("src/__mocks__/obsidian")),
    PluginSettingTab: class {
        containerEl = { ownerDocument: { defaultView: undefined } };
        hide() {}
        update() {}
    },
    SettingPage: class {},
}));
vi.mock("src/ui/modals/review-changes-modal", () => ({ showRestoreDraftModal: vi.fn(), showReviewChangesModal: vi.fn() }));

function setup() {
    const data = structuredClone(DEFAULT_SETTINGS);
    const settings = data.profiles[DEFAULT_PROFILE_ID].settings;
    const service = { data, persisted: structuredClone(data), currentProfileId: DEFAULT_PROFILE_ID };
    const plugin = {
        core: { settingsService: service },
        data,
        settings,
        manifests: [{ id: "foo", name: "Foo" }],
        configureLogger: vi.fn(),
        isPluginEnabledOnDisk: () => false,
    };
    const tab = new SettingsTab({} as App, plugin as unknown as OnDemandPlugin);
    return { tab, settings, service };
}

describe("settings draft lifecycle", () => {
    beforeEach(() => {
        vi.mocked(showRestoreDraftModal).mockReset().mockResolvedValue({ action: "restore", dontAskAgain: false });
        Notice.clearMessages();
    });

    it("keeps the draft live when returning from a sub-page", () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        tab.markDirty();
        tab.requestRestoreOnPageClose("maintenance");
        tab.offerRestoreOnPageOpen("maintenance");

        expect(settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(tab.hasPendingChanges).toBe(true);
        expect(showRestoreDraftModal).not.toHaveBeenCalled();
    });

    it("retains an older stash and newer edits from another page across closing", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY_ON_LAYOUT_READY;
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        tab.requestRestoreOnPageClose("plugin-management");
        tab.hide();
        expect(tab.hasPendingChanges).toBe(false);
        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(showRestoreDraftModal).toHaveBeenCalledOnce();
        expect(settings.defaultMode).toBe(PLUGIN_MODE.LAZY_ON_LAYOUT_READY);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("keeps newer edits to the same field when restoring an older draft", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };
        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
    });

    it("keeps newer edits to the same field when combining stashes on close", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };
        tab.requestRestoreOnPageClose("plugin-management");
        tab.hide();
        tab.offerRestoreOnPageOpen("plugin-management");
        await tab.restoring;

        expect(settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
    });

    it("discards only the offered stash while keeping newer live edits", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "discard", dontAskAgain: false });

        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(settings.defaultMode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
        expect(tab.hasPendingChanges).toBe(true);
    });

    it("combines drafts without undoing a save made between them", async () => {
        const { tab, settings, service } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };
        service.persisted = structuredClone(service.data);
        service.data.showConsoleLog = true;
        tab.requestRestoreOnPageClose("plugin-management");
        tab.hide();
        expect(service.data).toEqual(service.persisted);
        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(service.data.showConsoleLog).toBe(true);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
        expect(tab.getChangedPluginIds()).toEqual([]);
    });

    it("lists only what a restore would change, leaving out fields a newer edit overrides", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();
        // Foo is edited again before the offer, so restoring keeps this newer mode.
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };

        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        const getChanges = vi.mocked(showRestoreDraftModal).mock.calls[0][1];
        expect(getChanges().map(({ label, from, to }) => ({ label, from, to }))).toEqual([{ label: "Default mode", from: "⛔ Always disabled", to: "🤲 Lazy on demand" }]);
    });

    it("drops a stash whose every entry a newer edit overrides, without asking", async () => {
        const { tab, settings } = setup();
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_ENABLED };

        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(showRestoreDraftModal).not.toHaveBeenCalled();
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
    });

    it.each([
        ["restore", PLUGIN_MODE.LAZY, "Restored 1 unsaved change. Change this under Behaviour › Unsaved draft prompt."],
        ["discard", PLUGIN_MODE.ALWAYS_DISABLED, "Discarded 1 unsaved change. Change this under Behaviour › Unsaved draft prompt."],
    ] as const)("announces an automatic %s instead of acting silently", async (behavior, expectedMode, message) => {
        const { tab, settings, service } = setup();
        // Save the preference so it is not part of the draft.
        service.data.restoreDraftBehavior = behavior;
        service.persisted = structuredClone(service.data);
        settings.defaultMode = PLUGIN_MODE.LAZY;
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(showRestoreDraftModal).not.toHaveBeenCalled();
        expect(settings.defaultMode).toBe(expectedMode);
        expect(Notice.messages).toEqual([message]);
    });

    it("shows no notice when the user answers the prompt", async () => {
        const { tab, settings } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        tab.requestRestoreOnPageClose("maintenance");
        tab.hide();

        tab.offerRestoreOnPageOpen("maintenance");
        await tab.restoring;

        expect(showRestoreDraftModal).toHaveBeenCalledOnce();
        expect(Notice.messages).toEqual([]);
    });
});
