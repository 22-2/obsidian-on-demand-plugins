// @vitest-environment happy-dom
import type { App } from "obsidian";
import { Notice } from "src/__mocks__/obsidian";
import { installObsidianDom } from "src/__mocks__/obsidian-dom";
import { FeatureEvents } from "src/core/event-bus";
import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type { LazySettings } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { DraftSession, pendingSummary } from "src/ui/drafts/draft-session";
import type { ReviewChangesOptions } from "src/ui/modals/review-changes-modal";
import { showRestoreDraftModal, showReviewChangesModal } from "src/ui/modals/review-changes-modal";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => await import("src/__mocks__/obsidian"));
vi.mock("src/ui/modals/review-changes-modal", () => ({ showRestoreDraftModal: vi.fn(), showReviewChangesModal: vi.fn() }));

type Drift = { enabledExternally: string[]; disabledExternally: string[]; selfMissing: boolean };

function setup(options: { drift?: Drift | null; detectFails?: boolean } = {}) {
    const data = structuredClone(DEFAULT_SETTINGS);
    const settings = data.profiles[DEFAULT_PROFILE_ID].settings;
    const service = {
        data,
        persisted: structuredClone(data),
        currentProfileId: DEFAULT_PROFILE_ID,
        save: vi.fn(async (saved: LazySettings) => {
            service.persisted = structuredClone(saved);
        }),
    };
    const plugin = {
        core: { settingsService: service },
        data,
        settings,
        manifests: [{ id: "foo", name: "Foo" }],
        configureLogger: vi.fn(),
        isPluginEnabledOnDisk: (id: string) => id === "bar",
        saveSettings: vi.fn(async () => {
            service.persisted = structuredClone(service.data);
        }),
        loadSettings: vi.fn(async () => {
            // Put the saved values back into the live objects, as the settings service does on reload.
            Object.assign(settings, structuredClone(service.persisted.profiles[DEFAULT_PROFILE_ID].settings));
        }),
        events: { emit: vi.fn(async () => {}) },
        features: {
            get: () => ({
                detect: async () => {
                    if (options.detectFails) throw new Error("unreadable");
                    return options.drift ?? null;
                },
            }),
        },
    };
    const drafts = new DraftSession({} as App, plugin as unknown as OnDemandPlugin);
    const listener = vi.fn();
    drafts.onChange(listener);
    const stage = (id = "foo", mode: PLUGIN_MODE = PLUGIN_MODE.LAZY) => {
        settings.plugins[id] = { mode, userConfigured: true };
        drafts.pendingPluginIds.add(id);
        drafts.markDirty();
    };
    /** Stage an edit and close its only surface, leaving a stash to be offered from `page`. */
    const stash = (page: "plugin-table" | "plugin-management" | "maintenance" = "plugin-table") => {
        drafts.openSurface("plugin-table");
        stage();
        drafts.requestRestoreOnPageClose(page);
        drafts.closeSurface("plugin-table");
    };
    return { drafts, settings, service, plugin, listener, stage, stash };
}

/** What the last review showed, read while it was open: saving empties the draft afterwards. */
let reviewed: { mode: ReviewChangesOptions["mode"]; changes: ReturnType<ReviewChangesOptions["getChanges"]>; label: string } | undefined;

function answerReviews(confirm: boolean) {
    vi.mocked(showReviewChangesModal).mockImplementation(async (_app, options) => {
        reviewed = { mode: options.mode, changes: options.getChanges(), label: options.getConfirmLabel() };
        return confirm;
    });
}

beforeAll(() => installObsidianDom());

beforeEach(() => {
    vi.mocked(showRestoreDraftModal).mockReset().mockResolvedValue({ action: "restore", dontAskAgain: false });
    vi.mocked(showReviewChangesModal).mockReset();
    reviewed = undefined;
    answerReviews(true);
    Notice.clearMessages();
});

describe("draft session surfaces", () => {
    it("keeps the draft live while another surface stays open", () => {
        const { drafts, settings, stage } = setup();
        drafts.openSurface("settings");
        drafts.openSurface("plugin-table");
        stage();

        drafts.closeSurface("settings");

        expect(drafts.hasStash).toBe(false);
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("sets the draft aside once the last surface closes and offers it back on reopen", async () => {
        const { drafts, settings, stash, listener } = setup();
        stash();
        expect(drafts.hasStash).toBe(true);
        expect(settings.plugins.foo).toBeUndefined();

        drafts.openSurface("plugin-table");
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;

        expect(showRestoreDraftModal).toHaveBeenCalledOnce();
        expect(vi.mocked(showRestoreDraftModal).mock.calls[0][1]()).toHaveLength(1);
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
        expect(drafts.hasStash).toBe(false);
        expect(listener).toHaveBeenLastCalledWith("refresh", undefined);
    });

    it("lets the settings list and the table offer each other's draft, but not maintenance", async () => {
        const fromTable = setup();
        fromTable.stash("plugin-table");
        fromTable.drafts.offerRestoreOnPageOpen("maintenance");
        fromTable.drafts.offerRestoreOnPageOpen("plugin-management");
        await fromTable.drafts.restoring;
        expect(showRestoreDraftModal).toHaveBeenCalledOnce();

        const fromSettings = setup();
        fromSettings.stash("plugin-management");
        fromSettings.drafts.offerRestoreOnPageOpen("plugin-table");
        await fromSettings.drafts.restoring;
        expect(showRestoreDraftModal).toHaveBeenCalledTimes(2);
    });

    it("asks nothing when a page closes without a draft", async () => {
        const { drafts } = setup();
        drafts.requestRestoreOnPageClose("plugin-table");
        drafts.closeSurface("plugin-table");
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;
        expect(showRestoreDraftModal).not.toHaveBeenCalled();
        expect(drafts.hasStash).toBe(false);
    });

    it("discards the set-aside draft when the user declines it", async () => {
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "discard", dontAskAgain: false });
        const { drafts, settings, stash } = setup();
        stash();

        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;

        expect(settings.plugins.foo).toBeUndefined();
        expect(drafts.hasStash).toBe(false);
        expect(drafts.hasPendingChanges).toBe(false);
    });

    it("keeps the stash for later when the prompt is dismissed", async () => {
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "dismiss", dontAskAgain: false });
        const { drafts, stash } = setup();
        stash();
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;
        expect(drafts.hasStash).toBe(true);
    });

    it("remembers the answer when asked not to ask again", async () => {
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "discard", dontAskAgain: true });
        const { drafts, stash, service } = setup();
        stash();
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;
        expect(service.persisted.restoreDraftBehavior).toBe("discard");
    });

    it("still applies the answer when remembering it fails", async () => {
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "restore", dontAskAgain: true });
        const { drafts, stash, service, settings } = setup();
        stash();
        service.save.mockRejectedValueOnce(new Error("disk full"));
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;
        expect(Notice.messages).toContain("Could not save the restore preference. This choice still applies to this draft.");
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("follows an automatic restore or discard and says what it did", async () => {
        for (const behavior of ["restore", "discard"] as const) {
            Notice.clearMessages();
            const { drafts, stash, plugin, settings, service } = setup();
            // Saved as well as live, or the setting itself would be part of the stashed draft.
            plugin.data.restoreDraftBehavior = behavior;
            service.persisted.restoreDraftBehavior = behavior;
            stash();
            drafts.offerRestoreOnPageOpen("plugin-table");
            await drafts.restoring;
            expect(showRestoreDraftModal).not.toHaveBeenCalled();
            expect(Notice.messages[0]).toBe(`${behavior === "restore" ? "Restored" : "Discarded"} 1 unsaved change. Change this under Behaviour › Unsaved draft prompt.`);
            expect(settings.plugins.foo?.mode).toBe(behavior === "restore" ? PLUGIN_MODE.LAZY : undefined);
        }
    });

    it("drops a stash that a newer edit fully overrides, without asking", async () => {
        const { drafts, stash, stage } = setup();
        stash();
        drafts.openSurface("plugin-table");
        stage("foo", PLUGIN_MODE.LAZY);
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;
        expect(showRestoreDraftModal).not.toHaveBeenCalled();
        expect(drafts.hasStash).toBe(false);
    });

    it("restores quietly after a redraw", () => {
        const { drafts, stash, settings, listener } = setup();
        drafts.restoreQuietly();
        expect(listener).not.toHaveBeenCalledWith("refresh", undefined);

        stash();
        drafts.restoreQuietly();
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
        expect(listener).toHaveBeenLastCalledWith("refresh", undefined);
    });

    it("tells listeners which surface made an edit, until they unsubscribe or the session ends", () => {
        const { drafts } = setup();
        const listener = vi.fn();
        const unsubscribe = drafts.onChange(listener);
        const source = {};

        drafts.markDirty(source);
        expect(listener).toHaveBeenCalledWith("edit", source);

        unsubscribe();
        drafts.markDirty();
        expect(listener).toHaveBeenCalledOnce();
    });

    it("forgets the stash when disposed", () => {
        const { drafts, stash } = setup();
        stash();
        drafts.dispose();
        expect(drafts.hasStash).toBe(false);
    });
});

describe("draft session review and save", () => {
    it("saves and applies the plugins in the draft once the review confirms", async () => {
        const { drafts, stage, plugin, listener } = setup();
        stage();

        await drafts.reviewAndSave();

        expect(reviewed?.mode).toBe("save");
        expect(reviewed?.changes).toEqual([expect.objectContaining({ group: "plugins", label: "Foo" })]);
        expect(reviewed?.label).toBe("Save & apply (1)");
        expect(plugin.saveSettings).toHaveBeenCalledOnce();
        expect(plugin.events.emit).toHaveBeenCalledWith(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds: ["foo"], externalChangesConfirmed: true });
        expect(Notice.messages).toContain("Settings saved and applied");
        expect(drafts.hasPendingChanges).toBe(false);
        expect(listener).toHaveBeenLastCalledWith("refresh", undefined);
    });

    it("lists external edits that saving would overwrite", async () => {
        const { drafts, stage } = setup({ drift: { enabledExternally: ["foo"], disabledExternally: ["other"], selfMissing: true } });
        stage();
        await drafts.reviewAndSave();
        expect(reviewed?.changes.filter((change) => change.group === "external").map((change) => change.label)).toEqual(["Foo", "other", "On-Demand Plugins"]);
    });

    it("reviews without external edits when they cannot be read", async () => {
        const { drafts, stage } = setup({ detectFails: true });
        stage();
        await drafts.reviewAndSave();
        expect(reviewed?.changes).toHaveLength(1);
    });

    it("saves settings without applying when no plugin changed", async () => {
        const { drafts, settings, plugin } = setup();
        settings.defaultMode = PLUGIN_MODE.LAZY;
        drafts.markDirty();
        await drafts.reviewAndSave();
        expect(reviewed?.label).toBe("Save changes");
        expect(plugin.events.emit).not.toHaveBeenCalled();
        expect(Notice.messages).toContain("Settings saved");
    });

    it("keeps the draft when the review is cancelled", async () => {
        answerReviews(false);
        const { drafts, stage, plugin, listener } = setup();
        stage();
        await drafts.reviewAndSave();
        expect(plugin.saveSettings).not.toHaveBeenCalled();
        expect(drafts.hasPendingChanges).toBe(true);
        expect(listener).toHaveBeenLastCalledWith("refresh", undefined);
    });

    it("opens one review at a time", async () => {
        const { drafts, stage } = setup();
        stage();
        await Promise.all([drafts.reviewAndSave(), drafts.reviewAndSave()]);
        expect(showReviewChangesModal).toHaveBeenCalledOnce();
    });

    it("does nothing on save when the draft is clean", async () => {
        const { drafts, plugin } = setup();
        await drafts.saveChanges();
        expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("discards the draft once the discard review confirms", async () => {
        const { drafts, stage, plugin, settings } = setup();
        stage();
        expect(drafts.getChangedPluginIds()).toEqual(["foo"]);

        expect(await drafts.discardChanges()).toBe(true);

        expect(reviewed?.mode).toBe("discard");
        expect(reviewed?.changes).toHaveLength(1);
        expect(reviewed?.label).toBe("Discard all (1)");
        expect(plugin.loadSettings).toHaveBeenCalledOnce();
        expect(settings.plugins.foo).toBeUndefined();
        expect(Notice.messages).toContain("Changes discarded");
    });

    it("keeps the draft when the discard is cancelled", async () => {
        answerReviews(false);
        const { drafts, stage, plugin } = setup();
        stage();
        expect(await drafts.discardChanges()).toBe(false);
        expect(plugin.loadSettings).not.toHaveBeenCalled();
    });

    it("discards without a redraw when asked", async () => {
        const { drafts, stage, listener } = setup();
        stage();
        listener.mockClear();
        await drafts.discardPendingChanges(false);
        expect(listener).not.toHaveBeenCalled();
    });

    it("describes plugins it cannot name by their ID, and falls back to the on-disk mode", () => {
        const { drafts, settings } = setup();
        settings.plugins.bar = { mode: PLUGIN_MODE.LAZY, userConfigured: true };
        drafts.markDirty();
        expect(drafts.describeChanges()).toEqual([expect.objectContaining({ label: "bar", from: "✅ Always enabled", to: "🤲 Lazy on demand" })]);
    });
});

describe("pending summary", () => {
    it("counts the changes and breaks them down by group", () => {
        const fragment = pendingSummary([
            { group: "plugins", label: "a", to: "x" },
            { group: "plugins", label: "b", to: "x" },
            { group: "settings", label: "c", to: "x" },
            { group: "profiles", label: "d", to: "x" },
            { group: "external", label: "e", to: "x" },
        ]);
        expect(fragment.textContent).toBe("5 unsaved changes · 2 plugins, 1 setting, 1 profile change, 1 external change");
        expect(pendingSummary([{ group: "plugins", label: "a", to: "x" }]).textContent).toBe("1 unsaved change · 1 plugin");
    });
});
