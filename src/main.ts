import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { Plugin } from "obsidian";
import { EventBus, FeatureEvents } from "src/core/event-bus";
import { FeatureManager } from "src/core/feature-manager";
import type { SettingsChange } from "src/core/plugin-context";
import { createPluginContext } from "src/core/plugin-context";
import type { DeviceSettings, LazySettings } from "src/core/types";
import { PLUGIN_MODE } from "src/core/types";
import { toggleLoggerBy } from "src/core/utils";
import { BackupFeature } from "src/features/backup/backup-feature";
import type { CommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import { ManualToggleFeature } from "src/features/manual-toggle/manual-toggle-feature";
import { createPluginTableHost } from "src/features/plugin-table/plugin-table-host";
import { PluginTableView, VIEW_TYPE_PLUGIN_TABLE } from "src/features/plugin-table/plugin-table-view";
import { StartupPolicyFeature } from "src/features/startup-policy/startup-policy-feature";
import { CoreContainer } from "src/services/core-container";
import { SettingsTab } from "src/ui/settings-tab";
import type { MaintenanceOperations, SettingsUiHost } from "src/ui/settings-ui-host";
import type { DraftSource } from "src/ui/settings/pending-changes";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin implements SettingsUiHost {
    // Assigned during onload via loadSettings().
    data!: LazySettings;
    // Assigned during onload via loadSettings().
    declare settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    core!: CoreContainer;
    features!: FeatureManager;
    events!: EventBus;
    /** Holds the settings draft; set once settings are loaded. */
    settingsTab?: SettingsTab;

    async onload() {
        const ctx = createPluginContext(this);
        this.core = new CoreContainer(ctx, this);
        this.events = new EventBus();

        this.features = new FeatureManager(ctx, this.core, this.events);
        this.features.register(new BackupFeature());
        this.features.register(new MaintenanceFeature());
        this.features.register(new CommunityPluginsDriftFeature());
        this.features.register(new ManualToggleFeature());
        this.features.register(new LazyEngineFeature());
        this.features.register(new StartupPolicyFeature());

        try {
            await this.loadSettings();
        } catch (error) {
            // Reason: settings validation stops startup before features can safely use a default replacement.
            this.core.destroy();
            throw error;
        }
        this.configureLogger();

        // Registry needs to update manifests after settings are loaded
        this.core.registry.reloadManifests();
        this.updateManifests();

        // Full initialization (patches, command cache, view loader, etc.)
        await this.core.initialize();

        await this.features.loadAll();

        this.registerEventHandlers();

        // Opt-in cleanup at startup. Runs after loadAll() so the BackupFeature is
        // available to snapshot the pre-clean state first. Order vs. the lazy
        // engine is irrelevant: stale entries are keyed by uninstalled plugins,
        // which every manifest-driven path already skips.
        if (this.settings.pruneUninstalledEntries && (await this.backupAndPruneUninstalledEntries())) {
            await this.saveSettings();
        }

        this.settingsTab = new SettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        this.registerPluginTable(this.settingsTab);
    }

    /** The table shares the settings tab's draft; only the view is registered here, so startup builds no table. */
    private registerPluginTable(settingsTab: SettingsTab) {
        const host = createPluginTableHost(this, settingsTab.drafts);
        this.registerView(VIEW_TYPE_PLUGIN_TABLE, (leaf) => new PluginTableView(leaf, host));
        this.addCommand({ id: "open-plugin-table", name: "Open plugin table", callback: () => void this.openPluginTable() });
    }

    /** Reveals the open plugin table, or opens one in a new tab. */
    async openPluginTable() {
        const { workspace } = this.app;
        const leaf = workspace.getLeavesOfType(VIEW_TYPE_PLUGIN_TABLE)[0] ?? workspace.getLeaf("tab");
        if (leaf.view.getViewType() !== VIEW_TYPE_PLUGIN_TABLE) await leaf.setViewState({ type: VIEW_TYPE_PLUGIN_TABLE, active: true });
        await workspace.revealLeaf(leaf);
    }

    private registerEventHandlers() {
        this.events.on(FeatureEvents.REBUILD_CACHE_REQUESTED, async (options) => {
            const policyFeature = this.features.get(StartupPolicyFeature);
            await policyFeature?.rebuildWithProgress(null, options.force ?? false, { externalChangesConfirmed: options.externalChangesConfirmed });
        });

        this.events.on(FeatureEvents.APPLY_POLICIES_REQUESTED, async (options) => {
            const policyFeature = this.features.get(StartupPolicyFeature);
            if (policyFeature) {
                await policyFeature.applyWithProgress(null, options.pluginIds, { externalChangesConfirmed: options.externalChangesConfirmed });
            }
        });
    }

    onunload() {
        this.settingsTab?.dispose();
        this.features?.unloadAll();
        this.core?.destroy();
    }

    // ─── Settings ──────────────────────────────────────────────

    async loadSettings() {
        await this.core.settingsService.load();
        this.data = this.core.settingsService.data;
        this.settings = this.core.settingsService.settings;
        const profileId = this.core.settingsService.currentProfileId;
        this.device = this.core.settingsService.data.profiles[profileId]?.name ?? "Unknown";
    }

    async saveSettings(snapshot?: LazySettings) {
        await this.core.settingsService.save(snapshot);
    }

    get currentProfileId(): string {
        return this.core.settingsService.currentProfileId;
    }

    getDraftSource(): DraftSource | undefined {
        // Undefined until the core exists; the draft then compares against its own snapshot.
        return this.core?.settingsService;
    }

    // ─── Plugin configuration ──────────────────────────────────

    /**
     * Set the initial config value for all installed plugins.
     */
    async setupDefaultPluginConfigurations() {
        let hasChanges = false;
        for (const plugin of this.manifests) {
            const current = this.settings.plugins?.[plugin.id];
            if (!current || current.mode === undefined) {
                this.settings.plugins[plugin.id] = {
                    mode: this.getDefaultModeForPlugin(plugin.id),
                    userConfigured: false,
                };
                hasChanges = true;
                continue;
            }

            if (!current.userConfigured && current.mode === PLUGIN_MODE.ALWAYS_DISABLED && this.isPluginEnabledOnDisk(plugin.id)) {
                this.settings.plugins[plugin.id] = {
                    mode: PLUGIN_MODE.ALWAYS_ENABLED,
                    userConfigured: false,
                };
                hasChanges = true;
            }
        }

        // Opt-in cleanup: drop persisted state for plugins that are no longer
        // installed, so uninstalled entries don't accumulate indefinitely.
        if (this.settings.pruneUninstalledEntries && (await this.backupAndPruneUninstalledEntries())) {
            hasChanges = true;
        }

        // Reason: inferred defaults on a missing data.json may be waiting for Sync and should not be published at startup.
        if (hasChanges && !this.core.settingsService.isFirstLoad) {
            await this.saveSettings();
        }
    }

    /**
     * The current profile's maps whose keys are plugin IDs and may hold entries
     * for uninstalled plugins. The legacy in-data command cache is intentionally
     * excluded: it is dead data (the live cache lives in vault-scoped storage) and
     * is removed wholesale during settings load rather than pruned per key.
     */
    private pruneTargetMaps(): Record<string, unknown>[] {
        return [this.settings.plugins, this.settings.lazyOnViews, this.settings.lazyOnFiles];
    }

    /** True when any prune target holds an entry for a plugin not in the current manifests. */
    private hasUninstalledPluginEntries(): boolean {
        const installed = new Set(this.manifests.map((m) => m.id));
        return this.pruneTargetMaps().some((map) => Object.keys(map).some((id) => !installed.has(id)));
    }

    /**
     * Snapshot the current on-disk state via the backup feature (only when there is
     * something to remove, to avoid empty backups) and then prune in memory.
     * Persisting is left to the caller so the settings UI's deferred-save flow is
     * not disturbed. Returns true when anything was pruned.
     */
    async backupAndPruneUninstalledEntries(): Promise<boolean> {
        if (!this.hasUninstalledPluginEntries()) return false;
        // Back up before overwriting data.json with the pruned result, so the
        // removed entries can be recovered from the timestamped snapshot.
        await this.features.get(BackupFeature)?.createBackup();
        return this.pruneUninstalledPluginEntries();
    }

    /**
     * Remove persisted entries keyed by plugin IDs that are absent from the
     * current installed manifests. Returns true when anything was removed.
     */
    pruneUninstalledPluginEntries(): boolean {
        const installed = new Set(this.manifests.map((m) => m.id));
        let removed = false;

        for (const map of this.pruneTargetMaps()) {
            for (const id of Object.keys(map)) {
                if (!installed.has(id)) {
                    delete map[id];
                    removed = true;
                }
            }
        }

        return removed;
    }

    /**
     * Saves one change on top of the saved settings and applies it to the live ones,
     * so an unsaved settings draft never reaches data.json without its review.
     */
    async saveSettingsChange(change: SettingsChange) {
        if (this.settingsTab) {
            await this.settingsTab.saveImmediateChanges(change);
            return;
        }
        // Without the settings tab there is no draft, so the live settings are the saved ones.
        await change(this.data, this.core.settingsService.currentProfileId);
        await this.saveSettings();
    }

    async updatePluginSettings(pluginId: string, mode: PLUGIN_MODE) {
        await this.features.get(LazyEngineFeature)!.setPluginMode(pluginId, mode);
    }

    async applyStartupPolicyAndRestart(pluginIds?: string[]) {
        const policyFeature = this.features.get(StartupPolicyFeature);
        if (policyFeature) {
            await policyFeature.applyWithProgress(null, pluginIds);
        }
    }

    async applyPolicies(pluginIds: string[], options?: { externalChangesConfirmed?: boolean }) {
        await this.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds, externalChangesConfirmed: options?.externalChangesConfirmed });
    }

    async confirmExternalOverwrite(): Promise<boolean> {
        const drift = this.features.get(CommunityPluginsDriftFeature);
        return !drift || (await drift.confirmOverwrite());
    }

    async detectExternalChanges(): Promise<CommunityPluginsDrift | null> {
        try {
            return (await this.features.get(CommunityPluginsDriftFeature)?.detect()) ?? null;
        } catch {
            return null;
        }
    }

    async rebuildPluginCaches(pluginId: string): Promise<boolean> {
        const startupPolicy = this.features.get(StartupPolicyFeature);
        if (!startupPolicy) return false;
        await startupPolicy.rebuildPluginCaches(pluginId);
        return true;
    }

    async createBackup() {
        await this.features.get(BackupFeature)?.createBackup();
    }

    get maintenance(): MaintenanceOperations | undefined {
        return this.features.get(MaintenanceFeature);
    }

    async rebuildAndApplyCommandCache(options?: { force?: boolean; externalChangesConfirmed?: boolean }) {
        const maintenance = this.features.get(MaintenanceFeature);
        if (maintenance) {
            await maintenance.rebuildAndApplyCommandCache(options);
        }
    }

    /** Resolves false when the user keeps the profile because applying it would overwrite external edits. */
    async switchProfile(profileId: string): Promise<boolean> {
        // Ask before switching: cancelling after the save would leave a saved profile that was never applied.
        const drift = this.features.get(CommunityPluginsDriftFeature);
        if (drift && !(await drift.confirmOverwrite())) return false;
        this.core.settingsService.switchProfile(profileId);
        this.settings = this.core.settingsService.settings;
        await this.saveSettings();
        const policyFeature = this.features.get(StartupPolicyFeature);
        await policyFeature?.applyWithProgress(null, undefined, { externalChangesConfirmed: true });
        return true;
    }

    updateManifests() {
        this.core.registry.reloadManifests();
        this.manifests = this.core.registry.manifests;
    }

    getPluginMode(pluginId: string): PLUGIN_MODE {
        return this.settings.plugins?.[pluginId]?.mode ?? this.getDefaultModeForPlugin(pluginId);
    }

    getDefaultModeForPlugin(pluginId: string): PLUGIN_MODE {
        if (this.isPluginEnabledOnDisk(pluginId)) {
            return PLUGIN_MODE.ALWAYS_ENABLED;
        }
        return this.settings.defaultMode;
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return this.core.registry.isPluginEnabledOnDisk(pluginId);
    }

    // ─── Delegated operations ──────────────────────────────────
    configureLogger(): void {
        const level = this.data.showConsoleLog ? "debug" : "error";
        toggleLoggerBy(level, (name) => name.startsWith("OnDemandPlugin/"));
        logger.debug("Debug mode enabled");
    }
}
