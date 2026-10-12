import type { App, SettingDefinitionItem } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import { FeatureEvents } from "src/core/event-bus";
import { PLUGIN_MODE, PluginModes } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { showReviewChangesModal } from "src/ui/modals/review-changes-modal";
import { pluginManagementSummary } from "src/ui/settings/helpers";
import { MaintenancePage } from "src/ui/settings/pages/maintenance-page";
import { PluginPage } from "src/ui/settings/pages/plugin-page";
import { ProfileManagementPage } from "src/ui/settings/pages/profile-management-page";
import type { PendingChange, PendingChangeGroup } from "src/ui/settings/pending-changes";
import { PendingChanges } from "src/ui/settings/pending-changes";

export class SettingsTab extends PluginSettingTab {
    public plugin: OnDemandPlugin;
    private readonly pending: PendingChanges;
    constructor(app: App, plugin: OnDemandPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.pending = new PendingChanges(() => this.plugin.core?.settingsService);
    }
    get pendingPluginIds() {
        return this.pending.pluginIds;
    }
    get hasPendingChanges() {
        return this.pending.hasChanges;
    }
    getChangedPluginIds(): string[] {
        return this.pending.getChangedPluginIds();
    }
    getControlValue(key: string) {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }
    setControlValue(key: string, value: unknown) {
        const controls = this.plugin.settings as unknown as Record<string, unknown>;
        // Assigning the same value changes nothing, so keep the draft clean.
        if (Object.is(controls[key], value)) return;
        controls[key] = value;
        // Keep declarative controls on the same draft lifecycle as plugin modes;
        // otherwise Save/Discard cannot provide an atomic, predictable result.
        this.markDirty();
        this.update();
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
                desc: "Configure default loading behaviour.",
                items: [
                    {
                        name: "Changes",
                        desc: "Settings changes are staged until you save them.",
                        render: (setting) => this.configurePendingControls(setting),
                    },
                    { name: "Default mode", desc: "Default mode for newly discovered plugins.", control: { type: "dropdown", key: "defaultMode", options: modes } },
                    {
                        name: "Auto-remove uninstalled entries",
                        desc: "Prune settings for plugins that are no longer installed.",
                        render: (setting) => {
                            setting.addToggle((toggle) =>
                                toggle.setValue(this.plugin.settings.pruneUninstalledEntries).onChange(async (value) => {
                                    this.plugin.settings.pruneUninstalledEntries = value;
                                    this.markDirty();
                                    try {
                                        // Back up before pruning so enabling cleanup never loses
                                        // the stale entries before the user can save the draft.
                                        if (value) await this.plugin.backupAndPruneUninstalledEntries();
                                    } finally {
                                        this.update();
                                    }
                                }),
                            );
                        },
                    },
                ],
            },
            { type: "page", name: "Maintenance & batch", desc: "Rebuild caches and apply batch operations.", page: () => new MaintenancePage(this.plugin, this) },
        ];
    }
    markDirty() {
        this.pending.markDirty();
    }
    describeChanges(): PendingChange[] {
        return this.pending.describeChanges({
            pluginName: (pluginId) => this.plugin.manifests.find((manifest) => manifest.id === pluginId)?.name ?? pluginId,
            fallbackMode: (pluginId, settings) => (this.plugin.isPluginEnabledOnDisk(pluginId) ? PLUGIN_MODE.ALWAYS_ENABLED : settings.defaultMode),
        });
    }
    private saveButtonText() {
        const count = this.getChangedPluginIds().length;
        return count > 0 ? `Save & apply (${count})` : "Save changes";
    }
    private discardButtonText() {
        return `Discard all (${this.describeChanges().length})`;
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
        const confirmed = await showReviewChangesModal(this.app, {
            mode: "save",
            getChanges: () => this.describeChanges(),
            getConfirmLabel: () => this.saveButtonText(),
        });
        // Reverts in the modal edit the draft even when the save is cancelled.
        this.plugin.configureLogger();
        if (confirmed) await this.saveChanges();
        else this.update();
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
        this.pending.reset();
    }
    async saveChanges() {
        if (!this.hasPendingChanges) return;
        const pluginIds = this.getChangedPluginIds();
        await this.plugin.saveSettings();
        if (pluginIds.length > 0) {
            await this.plugin.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds });
        }
        this.resetPending();
        new Notice(pluginIds.length > 0 ? "Settings saved and applied" : "Settings saved");
        this.update();
    }
    async discardPendingChanges(refresh = true) {
        await this.plugin.loadSettings();
        // Debug logging is applied at runtime, so restore it after reloading the
        // persisted draft when the user discards changes.
        this.plugin.configureLogger();
        this.resetPending();
        if (refresh) this.update();
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
}

const GROUP_NOUNS: Record<PendingChangeGroup, [string, string]> = {
    plugins: ["plugin", "plugins"],
    settings: ["setting", "settings"],
    profiles: ["profile change", "profile changes"],
};

function pendingSummary(changes: PendingChange[]): DocumentFragment {
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
