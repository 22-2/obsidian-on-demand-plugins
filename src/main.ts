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
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import { ManualToggleFeature } from "src/features/manual-toggle/manual-toggle-feature";
import { StartupPolicyFeature } from "src/features/startup-policy/startup-policy-feature";
import { CoreContainer } from "src/services/core-container";
import { pluginLayerToEdit, resolveDeviceValue, resolvePluginUnit } from "src/services/settings/settings-layers";
import { SettingsTab } from "src/ui/settings-tab";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    // Assigned during onload via loadSettings().
    data!: LazySettings;
    /**
     * The settings the active profile runs with: its overrides on top of the shared defaults.
     * A fresh copy on every read, so edits must go to a layer (see settings-layers) to be kept.
     * Defined as a getter in onload, since Obsidian's Plugin declares `settings` as a property.
     */
    declare settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    core!: CoreContainer;
    features!: FeatureManager;
    events!: EventBus;
    /** Holds the settings draft; set once settings are loaded. */
    settingsTab?: SettingsTab;

    async onload() {
        Object.defineProperty(this, "settings", { configurable: true, get: () => this.core.settingsService.settings });
        const ctx = createPluginContext(this);
        this.core = new CoreContainer(ctx);
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
    }

    private registerEventHandlers() {
        this.events.on(FeatureEvents.REBUILD_CACHE_REQUESTED, async (options: { force?: boolean; externalChangesConfirmed?: boolean }) => {
            const policyFeature = this.features.get(StartupPolicyFeature);
            await policyFeature?.rebuildWithProgress(null, options?.force ?? false, { externalChangesConfirmed: options?.externalChangesConfirmed });
        });

        this.events.on(FeatureEvents.APPLY_POLICIES_REQUESTED, async (options: { pluginIds?: string[]; externalChangesConfirmed?: boolean }) => {
            const policyFeature = this.features.get(StartupPolicyFeature);
            if (policyFeature) {
                await policyFeature.applyWithProgress(null, options?.pluginIds, { externalChangesConfirmed: options?.externalChangesConfirmed });
            }
        });
    }

    onunload() {
        this.settingsTab?.dispose();
        void this.features?.unloadAll();
        this.core?.destroy();
    }

    // ─── Settings ──────────────────────────────────────────────

    async loadSettings() {
        await this.core.settingsService.load();
        this.data = this.core.settingsService.data;
        const profileId = this.core.settingsService.currentProfileId;
        this.device = this.core.settingsService.data.profiles[profileId]?.name ?? "Unknown";
    }

    async saveSettings() {
        await this.core.settingsService.save();
    }

    // ─── Plugin configuration ──────────────────────────────────

    /**
     * Set the initial config value for all installed plugins.
     */
    async setupDefaultPluginConfigurations() {
        let hasChanges = false;
        for (const plugin of this.manifests) {
            const current = this.settings.plugins[plugin.id];
            if (!current || current.mode === undefined) {
                pluginLayerToEdit(this.data, this.core.settingsService.currentProfileId, plugin.id).plugins[plugin.id] = {
                    mode: this.getDefaultModeForPlugin(plugin.id),
                    userConfigured: false,
                };
                hasChanges = true;
                continue;
            }

            if (!current.userConfigured && current.mode === PLUGIN_MODE.ALWAYS_DISABLED && this.isPluginEnabledOnDisk(plugin.id)) {
                pluginLayerToEdit(this.data, this.core.settingsService.currentProfileId, plugin.id).plugins[plugin.id] = {
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
        // Only the active profile's own entries: the shared defaults also serve devices where those plugins are installed.
        const settings = this.core.settingsService.activeProfile.settings;
        return [settings.plugins, settings.lazyOnViews, settings.lazyOnFiles];
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
        // Mode changes must not erase the plugin's advanced lazy rules; those
        // rules are independent of whether the plugin is currently enabled.
        await this.saveSettingsChange((data, profileId) => {
            const plugins = pluginLayerToEdit(data, profileId, pluginId).plugins;
            plugins[pluginId] = { ...(plugins[pluginId] ?? {}), mode, userConfigured: true };
        });
        const lazyEngine = this.features.get(LazyEngineFeature);
        await lazyEngine!.applyPluginState(pluginId);
    }

    async applyStartupPolicyAndRestart(pluginIds?: string[]) {
        const policyFeature = this.features.get(StartupPolicyFeature);
        if (policyFeature) {
            await policyFeature.applyWithProgress(null, pluginIds);
        }
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
        await this.saveSettings();
        const policyFeature = this.features.get(StartupPolicyFeature);
        await policyFeature?.applyWithProgress(null, undefined, { externalChangesConfirmed: true });
        return true;
    }

    updateManifests() {
        this.core.registry.reloadManifests();
        this.manifests = this.core.registry.manifests;
    }

    // These two read the layers directly: they run for every plugin, and building the effective settings each time would be wasteful.
    getPluginMode(pluginId: string): PLUGIN_MODE {
        const service = this.core.settingsService;
        return resolvePluginUnit(service.activeProfile, service.data.defaults, pluginId).plugin?.mode ?? this.getDefaultModeForPlugin(pluginId);
    }

    getDefaultModeForPlugin(pluginId: string): PLUGIN_MODE {
        if (this.isPluginEnabledOnDisk(pluginId)) {
            return PLUGIN_MODE.ALWAYS_ENABLED;
        }
        const service = this.core.settingsService;
        return resolveDeviceValue(service.activeProfile, service.data.defaults, "defaultMode");
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
