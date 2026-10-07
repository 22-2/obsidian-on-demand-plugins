import type { App, SettingDefinitionItem } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { FeatureEvents } from "src/core/event-bus";
import { PluginModes } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { pluginManagementSummary } from "src/ui/settings/helpers";
import { MaintenancePage } from "src/ui/settings/pages/maintenance-page";
import { PluginPage } from "src/ui/settings/pages/plugin-page";
import { ProfileManagementPage } from "src/ui/settings/pages/profile-management-page";
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
    configurePendingControls(setting: Setting, onRefresh?: () => void) {
        setting.setClass("lazy-plugin-save-controls");
        // Sticky positioning applies only with pending changes so the bar does not cling to the top when there is nothing to save.
        setting.settingEl.toggleClass("has-pending-changes", this.hasPendingChanges);
        const changedPluginIds = this.getChangedPluginIds();
        setting
            .setName("Changes")
            .setDesc("Settings changes are staged until you save them. Plugin mode changes are applied when saved.")
            .addButton((button) =>
                button
                    .setButtonText(changedPluginIds.length > 0 ? `Save & apply (${changedPluginIds.length})` : "Save changes")
                    .setCta()
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(async () => {
                        await this.saveChanges();
                        onRefresh?.();
                    }),
            )
            .addButton((button) =>
                button
                    .setButtonText("Discard")
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(async () => {
                        if (await this.discardChanges()) onRefresh?.();
                    }),
            );
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
        if (!(await showConfirmModal(this.app, { message: "Discard all unsaved changes?" }))) return false;
        await this.discardPendingChanges();
        new Notice("Changes discarded");
        return true;
    }
}
