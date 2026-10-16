import type { App } from "obsidian";
import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { DraftSession } from "src/ui/drafts/draft-session";
import { showRestoreDraftModal } from "src/ui/modals/review-changes-modal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => await import("src/__mocks__/obsidian"));
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
    const drafts = new DraftSession({} as App, plugin as unknown as OnDemandPlugin);
    return { drafts, settings };
}

describe("draft session surfaces", () => {
    beforeEach(() => {
        vi.mocked(showRestoreDraftModal).mockReset().mockResolvedValue({ action: "restore", dontAskAgain: false });
    });

    it("keeps the draft live while another surface stays open", () => {
        const { drafts, settings } = setup();
        drafts.openSurface("settings");
        drafts.openSurface("plugin-table");
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        drafts.markDirty();

        drafts.closeSurface("settings");

        expect(drafts.hasStash).toBe(false);
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("sets the draft aside once the last surface closes and offers it back on reopen", async () => {
        const { drafts, settings } = setup();
        drafts.openSurface("plugin-table");
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        drafts.markDirty();
        drafts.requestRestoreOnPageClose("plugin-table");

        drafts.closeSurface("plugin-table");
        expect(drafts.hasStash).toBe(true);
        expect(settings.plugins.foo).toBeUndefined();

        drafts.openSurface("plugin-table");
        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;

        expect(showRestoreDraftModal).toHaveBeenCalledOnce();
        expect(settings.plugins.foo?.mode).toBe(PLUGIN_MODE.LAZY);
        expect(drafts.hasStash).toBe(false);
    });

    it("discards the set-aside draft when the user declines it", async () => {
        vi.mocked(showRestoreDraftModal).mockResolvedValue({ action: "discard", dontAskAgain: false });
        const { drafts, settings } = setup();
        drafts.openSurface("plugin-table");
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        drafts.markDirty();
        drafts.requestRestoreOnPageClose("plugin-table");
        drafts.closeSurface("plugin-table");

        drafts.offerRestoreOnPageOpen("plugin-table");
        await drafts.restoring;

        expect(settings.plugins.foo).toBeUndefined();
        expect(drafts.hasStash).toBe(false);
        expect(drafts.hasPendingChanges).toBe(false);
    });

    it("tells listeners which surface made an edit", () => {
        const { drafts } = setup();
        const listener = vi.fn();
        drafts.onChange(listener);
        const source = {};

        drafts.markDirty(source);

        expect(listener).toHaveBeenCalledWith("edit", source);
    });
});
