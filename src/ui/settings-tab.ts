import type { App, SettingDefinitionItem } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_DEVICE_SETTINGS, PluginModes } from "src/core/types";
import type { RestoreDraftBehavior } from "src/core/types";
import { BackupFeature } from "src/features/backup/backup-feature";
import type OnDemandPlugin from "src/main";
import { DraftSession, pendingSummary } from "src/ui/drafts/draft-session";
import { pluginManagementSummary } from "src/ui/settings/helpers";
import { MaintenancePage } from "src/ui/settings/pages/maintenance-page";
import { PluginPage } from "src/ui/settings/pages/plugin-page";
import { ProfileManagementPage } from "src/ui/settings/pages/profile-management-page";
import type { ImmediateSettingsChange, PendingChange } from "src/ui/settings/pending-changes";
import { RESTORE_DRAFT_BEHAVIOR_LABELS } from "src/ui/settings/pending-changes";

export class SettingsTab extends PluginSettingTab {
    public plugin: OnDemandPlugin;
    /** The draft shared with the plugin table; this tab is one of its surfaces. */
    readonly drafts: DraftSession;
    constructor(app: App, plugin: OnDemandPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.drafts = new DraftSession(app, plugin);
        this.unsubscribeDrafts = this.drafts.onChange((kind) => {
            // In-place edits come from pages that update their own rows; a replaced draft needs a full redraw.
            if (kind === "refresh") this.update();
        });
        const view = this.containerEl.ownerDocument.defaultView;
        if (view) {
            this.renderObserver = new view.MutationObserver((records) => {
                if (records.some((record) => record.addedNodes.length > 0)) this.onRendered();
            });
            this.renderObserver.observe(this.containerEl, { childList: true });
        }
    }
    get pendingPluginIds() {
        return this.drafts.pendingPluginIds;
    }
    get hasPendingChanges() {
        return this.drafts.hasPendingChanges;
    }
    /** The last restore offer, for callers that need to wait for it. */
    get restoring(): Promise<void> {
        return this.drafts.restoring;
    }
    getChangedPluginIds(): string[] {
        return this.drafts.getChangedPluginIds();
    }
    getControlValue(key: string) {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }
    async setControlValue(key: string, value: unknown) {
        await this.saveImmediateChanges((data, profileId) => {
            (data.profiles[profileId].settings as unknown as Record<string, unknown>)[key] = value;
        });
        this.update();
    }
    private readonly unsubscribeDrafts: () => void;
    /**
     * Obsidian has no event for a tab being shown and reuses its cached definitions, but it
     * renders the tab's content into containerEl each time, so a render marks the tab as shown.
     */
    private readonly renderObserver?: MutationObserver;
    private shown = false;
    /** Set when a shown tab hides; a render before the current task ends is the same tab redrawn, not a reopen. */
    private redrawing = false;
    hide() {
        super.hide();
        // Obsidian also calls hide() just before showing a tab that is still its active one,
        // e.g. when settings open again, so only a hide while shown is the user leaving.
        const wasShown = this.shown;
        this.shown = false;
        this.drafts.closeSurface("settings");
        if (!wasShown || !this.drafts.hasStash) return;
        // Clicking the open tab again makes Obsidian hide and redraw it in one go.
        this.redrawing = true;
        this.containerEl.ownerDocument.defaultView?.setTimeout(() => (this.redrawing = false), 0);
    }
    private onRendered() {
        this.shown = true;
        this.drafts.openSurface("settings");
        if (this.redrawing) this.drafts.restoreQuietly();
    }
    /** Remember the page to offer after a tab close; navigating within this tab keeps edits live. */
    requestRestoreOnPageClose(page: "plugin-management" | "maintenance") {
        this.drafts.requestRestoreOnPageClose(page);
    }
    /** Offer a stashed draft only after its page was previously left. */
    offerRestoreOnPageOpen(page: "plugin-management" | "maintenance") {
        // A redraw restores quietly instead, so it never asks.
        if (!this.redrawing) this.drafts.offerRestoreOnPageOpen(page);
    }
    /** Stops watching renders; the stash goes with the plugin, as it lives for this session only. */
    dispose() {
        this.renderObserver?.disconnect();
        this.unsubscribeDrafts();
        this.drafts.dispose();
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        this.plugin.updateManifests();
        const modes: Record<string, string> = { ...PluginModes };
        return [
            { type: "page", name: "Profile management", desc: "Manage profiles and device defaults.", page: () => new ProfileManagementPage(this.app, this.plugin, this) },
            {
                type: "page",
                name: "Plugin management",
                desc: "Configure plugin loading modes.",
                // Keep the familiar total visible beside the page name while compactly surfacing its mode breakdown.
                displayValue: () => pluginManagementSummary(this.plugin),
                page: () => new PluginPage(this.app, this.plugin, this),
            },
            {
                type: "page",
                name: "Behaviour",
                desc: "Configure loading and unsaved draft behaviour.",
                items: [
                    {
                        type: "group",
                        heading: "Current profile",
                        items: [
                            { name: "Default mode", desc: "Default mode for newly discovered plugins.", control: { type: "dropdown", key: "defaultMode", options: modes } },
                            {
                                name: "Auto-remove uninstalled entries",
                                desc: "Prune settings for plugins that are no longer installed.",
                                render: (setting) => {
                                    setting.addToggle((toggle) =>
                                        toggle.setValue(this.plugin.settings.pruneUninstalledEntries).onChange(async (value) => {
                                            try {
                                                await this.saveImmediateChanges(async (data, profileId) => {
                                                    const settings = data.profiles[profileId].settings;
                                                    settings.pruneUninstalledEntries = value;
                                                    if (!value) return;
                                                    const installed = new Set(this.plugin.manifests.map((manifest) => manifest.id));
                                                    const maps = [settings.plugins, settings.lazyOnViews, settings.lazyOnFiles];
                                                    if (!maps.some((map) => Object.keys(map).some((id) => !installed.has(id)))) return;
                                                    await this.plugin.features.get(BackupFeature)?.createBackup();
                                                    for (const map of maps) {
                                                        for (const id of Object.keys(map)) if (!installed.has(id)) delete map[id];
                                                    }
                                                });
                                            } finally {
                                                this.update();
                                            }
                                        }),
                                    );
                                },
                            },
                        ],
                    },
                    {
                        type: "group",
                        heading: "Shared across profiles",
                        items: [
                            {
                                name: "Unsaved draft prompt",
                                desc: "What to do with unsaved plugin changes when you return to plugin management or maintenance.",
                                // A render rather than a control: controls read and write the active profile, and this setting is shared.
                                render: (setting) => {
                                    setting.addDropdown((dropdown) => {
                                        for (const [value, label] of Object.entries(RESTORE_DRAFT_BEHAVIOR_LABELS)) dropdown.addOption(value, label);
                                        dropdown.setValue(this.plugin.data.restoreDraftBehavior ?? "ask").onChange(async (value) => {
                                            await this.saveImmediateChanges((data) => {
                                                data.restoreDraftBehavior = value as RestoreDraftBehavior;
                                            });
                                        });
                                    });
                                },
                            },
                        ],
                    },
                ],
            },
            { type: "page", name: "Maintenance & batch", desc: "Rebuild caches and apply batch operations.", page: () => new MaintenancePage(this.plugin, this) },
        ];
    }
    markDirty() {
        this.drafts.markDirty(this);
    }
    async saveImmediateChanges(change: ImmediateSettingsChange): Promise<void> {
        await this.drafts.saveImmediateChanges(change);
    }
    async waitForImmediateSaves(): Promise<void> {
        await this.drafts.waitForImmediateSaves();
    }
    async createProfile(name: string, sourceProfileId?: string): Promise<void> {
        const id = this.containerEl.ownerDocument.defaultView!.crypto.randomUUID();
        await this.saveImmediateChanges((data) => {
            const settings = sourceProfileId ? data.profiles[sourceProfileId].settings : DEFAULT_DEVICE_SETTINGS;
            data.profiles[id] = { id, name, settings: structuredClone(settings) };
        });
    }
    describeChanges(): PendingChange[] {
        return this.drafts.describeChanges();
    }
    configurePendingControls(setting: Setting, onRefresh?: () => void) {
        setting.setClass("lazy-plugin-save-controls");
        // Sticky positioning applies only with pending changes so the bar does not cling to the top when there is nothing to save.
        setting.settingEl.toggleClass("has-pending-changes", this.hasPendingChanges);
        const changes = this.describeChanges();
        // A single summary line keeps the pinned bar short; the details live in the review modal.
        if (changes.length > 0) setting.setName(pendingSummary(changes)).setDesc("");
        else setting.setName("Changes").setDesc("Settings changes are staged until you save them.");
        setting
            .addButton((button) =>
                button
                    // The ellipsis and "Review" signal that a confirmation follows, so the bar never reads as an immediate save.
                    .setButtonText("Review & save…")
                    .setCta()
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(() => void this.reviewAndSave(onRefresh)),
            )
            .addButton((button) =>
                button
                    .setButtonText("Discard…")
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(() => void this.discardFromBar(onRefresh)),
            );
    }
    // Obsidian shows a loading spinner on a button while its click handler is pending, so the
    // handlers stay synchronous and the awaiting happens here. Otherwise the spinner would stay on for the whole review.
    private async reviewAndSave(onRefresh?: () => void) {
        await this.drafts.reviewAndSave();
        onRefresh?.();
    }
    private async discardFromBar(onRefresh?: () => void) {
        if (await this.discardChanges()) onRefresh?.();
    }
    renderPendingControls(container: HTMLElement, onRefresh?: () => void) {
        container.querySelector(".lazy-plugin-save-controls")?.remove();
        // Show the pinned bar only while a draft exists so Plugin/Profile/Maintenance pages stay unpinned when clean.
        if (!this.hasPendingChanges) return;
        const setting = new Setting(container);
        this.configurePendingControls(setting, onRefresh);
        container.prepend(setting.settingEl);
    }
    resetPending() {
        this.drafts.resetPending();
    }
    async saveChanges(options?: { externalChangesConfirmed?: boolean }) {
        await this.drafts.saveChanges(options);
    }
    async discardPendingChanges(refresh = true) {
        await this.drafts.discardPendingChanges(refresh);
    }
    async discardChanges(): Promise<boolean> {
        return this.drafts.discardChanges();
    }
}
