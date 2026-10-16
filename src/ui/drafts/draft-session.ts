import type { App } from "obsidian";
import { Notice } from "obsidian";
import { FeatureEvents } from "src/core/event-bus";
import { PLUGIN_MODE } from "src/core/types";
import type { RestoreDraftBehavior } from "src/core/types";
import type { CommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import type OnDemandPlugin from "src/main";
import { showRestoreDraftModal, showReviewChangesModal } from "src/ui/modals/review-changes-modal";
import type { ChangeDescriber, DraftStash, ImmediateSettingsChange, PendingChange, PendingChangeGroup } from "src/ui/settings/pending-changes";
import { PendingChanges } from "src/ui/settings/pending-changes";

/** Places that offer a set-aside draft back when they open again. */
export type RestorePage = "plugin-management" | "maintenance" | "plugin-table";

/** Places that edit the draft; it is set aside only once none of them is open. */
export type DraftSurface = "settings" | "plugin-table";

/**
 * "edit": a surface changed the live draft in place.
 * "refresh": the draft was replaced as a whole (saved, discarded, restored or reverted in a review).
 */
export type DraftChangeKind = "edit" | "refresh";
export type DraftListener = (kind: DraftChangeKind, source: unknown) => void;

/**
 * The single unsaved settings draft shared by the settings tab and the plugin table.
 * Both edit the same live settings, so one draft, one review and one restore offer
 * keep them from overwriting each other.
 */
export class DraftSession {
    private readonly app: App;
    private readonly plugin: OnDemandPlugin;
    private readonly pending: PendingChanges;
    private readonly listeners = new Set<DraftListener>();
    private readonly openSurfaces = new Set<DraftSurface>();
    /** A draft set aside when the last surface closed; kept for this session only. */
    private stash?: DraftStash;
    private readonly restoreOfferRequested = new Set<RestorePage>();
    private restoreOfferInProgress = false;
    private reviewing = false;
    /** The last restore offer, for callers that need to wait for it. */
    restoring: Promise<void> = Promise.resolve();

    constructor(app: App, plugin: OnDemandPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.pending = new PendingChanges(() => this.plugin.core?.settingsService);
    }

    get pendingPluginIds() {
        return this.pending.pluginIds;
    }
    get hasPendingChanges() {
        return this.pending.hasChanges;
    }
    get hasStash() {
        return this.stash !== undefined;
    }
    getChangedPluginIds(): string[] {
        return this.pending.getChangedPluginIds();
    }
    describeChanges(): PendingChange[] {
        return this.pending.describeChanges(this.describer());
    }

    /** Subscribe to draft changes; returns the unsubscribe function. */
    onChange(listener: DraftListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    private notify(kind: DraftChangeKind, source?: unknown) {
        for (const listener of this.listeners) listener(kind, source);
    }

    /** Call after editing the live settings; `source` lets the editing surface skip its own echo. */
    markDirty(source?: unknown) {
        this.pending.markDirty();
        this.notify("edit", source);
    }

    openSurface(surface: DraftSurface) {
        this.openSurfaces.add(surface);
    }
    /**
     * Obsidian cannot keep settings open, so an unsaved draft is taken out when its
     * last surface closes: until the user decides, On-Demand keeps running on the saved settings.
     */
    closeSurface(surface: DraftSurface) {
        this.openSurfaces.delete(surface);
        if (this.openSurfaces.size === 0) this.stashPendingDraft();
    }

    /** Remember the page to offer after a close; navigating while a surface stays open keeps edits live. */
    requestRestoreOnPageClose(page: RestorePage) {
        if (this.pending.hasChanges) this.restoreOfferRequested.add(page);
    }
    /** Offer a stashed draft only after its page was previously left. */
    offerRestoreOnPageOpen(page: RestorePage) {
        if (this.restoreOfferRequested.has(page) && this.stash && !this.restoreOfferInProgress) this.restoring = this.offerRestore();
    }

    private stashPendingDraft() {
        // Keep an older stash when there is nothing new, so a quick look does not lose it.
        const stash = this.pending.stashDraft(this.stash);
        if (!stash) return;
        this.stash = stash;
        this.plugin.configureLogger();
    }

    /** Puts the stash back without asking, for a surface that was only redrawn rather than left. */
    restoreQuietly() {
        const stash = this.stash;
        if (!stash) return;
        this.stash = undefined;
        this.restoreOfferRequested.clear();
        this.pending.restoreDraft(stash);
        this.plugin.configureLogger();
        this.notify("refresh");
    }

    private async offerRestore() {
        if (this.restoreOfferInProgress) return;
        this.restoreOfferInProgress = true;
        try {
            const stash = this.stash;
            if (!stash) return;
            const changes = this.pending.describeStash(stash, this.describer());
            if (changes.length === 0) {
                this.stash = undefined;
                this.restoreOfferRequested.clear();
                return;
            }
            const behavior = this.plugin.data.restoreDraftBehavior ?? "ask";
            const choice = behavior === "ask" ? await showRestoreDraftModal(this.app, () => changes) : { action: behavior, dontAskAgain: false };
            // An automatic choice is otherwise invisible, so say what happened and how to change it.
            if (behavior !== "ask" && this.stash === stash) {
                const count = `${changes.length} unsaved ${changes.length === 1 ? "change" : "changes"}`;
                new Notice(`${behavior === "restore" ? "Restored" : "Discarded"} ${count}. Change this under Behaviour › Unsaved draft prompt.`);
            }
            if (choice.action === "dismiss" || this.stash !== stash) return;
            if (choice.dontAskAgain) {
                try {
                    await this.saveImmediateChanges((data) => {
                        data.restoreDraftBehavior = choice.action as RestoreDraftBehavior;
                    });
                } catch {
                    new Notice("Could not save the restore preference. This choice still applies to this draft.");
                }
            }
            this.stash = undefined;
            this.restoreOfferRequested.clear();
            if (choice.action === "restore") {
                this.pending.restoreDraft(stash);
                this.plugin.configureLogger();
            }
            this.notify("refresh");
        } finally {
            this.restoreOfferInProgress = false;
        }
    }

    async saveImmediateChanges(change: ImmediateSettingsChange): Promise<void> {
        await this.pending.saveImmediately(change, (data) => this.plugin.core.settingsService.save(data));
    }
    async waitForImmediateSaves(): Promise<void> {
        await this.pending.waitForImmediateSaves();
    }

    private describer(): ChangeDescriber {
        return {
            pluginName: (pluginId) => this.plugin.manifests.find((manifest) => manifest.id === pluginId)?.name ?? pluginId,
            fallbackMode: (pluginId, settings) => (this.plugin.isPluginEnabledOnDisk(pluginId) ? PLUGIN_MODE.ALWAYS_ENABLED : settings.defaultMode),
        };
    }
    private async detectExternalChanges(): Promise<CommunityPluginsDrift | null> {
        try {
            return (await this.plugin.features.get(CommunityPluginsDriftFeature)?.detect()) ?? null;
        } catch {
            return null;
        }
    }
    private describeExternalChanges(drift: CommunityPluginsDrift): PendingChange[] {
        const nameOf = (pluginId: string) => this.plugin.manifests.find((manifest) => manifest.id === pluginId)?.name ?? pluginId;
        const removed = (label: string): PendingChange => ({ group: "external", label, from: "Enabled outside On-Demand", to: "Removed from community-plugins.json" });
        const readded = (label: string): PendingChange => ({ group: "external", label, from: "Disabled outside On-Demand", to: "Re-added to community-plugins.json" });
        const changes = [...drift.enabledExternally.map((id) => removed(nameOf(id))), ...drift.disabledExternally.map((id) => readded(nameOf(id)))];
        if (drift.selfMissing) changes.push(readded("On-Demand Plugins"));
        return changes;
    }
    private saveButtonText() {
        const count = this.getChangedPluginIds().length;
        return count > 0 ? `Save & apply (${count})` : "Save changes";
    }
    private discardButtonText() {
        return `Discard all (${this.describeChanges().length})`;
    }

    /** Opens the review and saves on confirm. Concurrent calls are ignored while one review is open. */
    async reviewAndSave(): Promise<void> {
        // The file read below runs before the modal covers the button, so a double click could open two reviews.
        if (this.reviewing) return;
        this.reviewing = true;
        try {
            await this.runReview();
        } finally {
            this.reviewing = false;
        }
    }
    private async runReview() {
        const drift = await this.detectExternalChanges();
        const confirmed = await showReviewChangesModal(this.app, {
            mode: "save",
            // Only an apply rewrites community-plugins.json, so external edits matter only while plugin changes remain.
            getChanges: () => {
                const changes = this.describeChanges();
                return drift && this.getChangedPluginIds().length > 0 ? [...changes, ...this.describeExternalChanges(drift)] : changes;
            },
            getConfirmLabel: () => this.saveButtonText(),
        });
        // Reverts in the modal edit the draft even when the save is cancelled.
        this.plugin.configureLogger();
        if (confirmed) await this.saveChanges({ externalChangesConfirmed: true });
        else this.notify("refresh");
    }

    resetPending() {
        this.pending.reset();
    }
    async saveChanges(options?: { externalChangesConfirmed?: boolean }) {
        await this.waitForImmediateSaves();
        if (!this.hasPendingChanges) return;
        const pluginIds = this.getChangedPluginIds();
        await this.plugin.saveSettings();
        if (pluginIds.length > 0) {
            await this.plugin.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds, externalChangesConfirmed: options?.externalChangesConfirmed });
        }
        this.resetPending();
        new Notice(pluginIds.length > 0 ? "Settings saved and applied" : "Settings saved");
        this.notify("refresh");
    }
    async discardPendingChanges(refresh = true) {
        await this.waitForImmediateSaves();
        await this.plugin.loadSettings();
        // Debug logging is applied at runtime, so restore it after reloading the
        // persisted draft when the user discards changes.
        this.plugin.configureLogger();
        this.resetPending();
        if (refresh) this.notify("refresh");
    }
    async discardChanges(): Promise<boolean> {
        const confirmed = await showReviewChangesModal(this.app, {
            mode: "discard",
            getChanges: () => this.describeChanges(),
            getConfirmLabel: () => this.discardButtonText(),
        });
        if (!confirmed) return false;
        await this.discardPendingChanges();
        new Notice("Changes discarded");
        return true;
    }

    /** Drops the stash with the plugin, as it lives for this session only. */
    dispose() {
        this.stash = undefined;
        this.restoreOfferRequested.clear();
        this.openSurfaces.clear();
        this.listeners.clear();
    }
}

const GROUP_NOUNS: Record<PendingChangeGroup, [string, string]> = {
    plugins: ["plugin", "plugins"],
    settings: ["setting", "settings"],
    profiles: ["profile change", "profile changes"],
    external: ["external change", "external changes"],
};

/** "3 unsaved changes" plus a per-group breakdown, for the bars that carry Review & save. */
export function pendingSummary(changes: PendingChange[]): DocumentFragment {
    const breakdown = (Object.keys(GROUP_NOUNS) as PendingChangeGroup[])
        .map((group) => {
            const count = changes.filter((change) => change.group === group).length;
            const [singular, plural] = GROUP_NOUNS[group];
            return count > 0 ? `${count} ${count === 1 ? singular : plural}` : "";
        })
        .filter(Boolean)
        .join(", ");
    return createFragment((fragment) => {
        fragment.createSpan({ text: `${changes.length} unsaved ${changes.length === 1 ? "change" : "changes"}` });
        fragment.createSpan({ cls: "lazy-plugin-save-summary", text: ` · ${breakdown}` });
    });
}
