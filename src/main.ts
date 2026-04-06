import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { Plugin } from "obsidian";
import { EventBus, FeatureEvents } from "src/core/event-bus";
import { FeatureManager } from "src/core/feature-manager";
import { createPluginContext } from "src/core/plugin-context";
import { ProgressDialog } from "src/core/progress";
import type { DeviceSettings, LazySettings, PLUGIN_MODE } from "src/core/types";
import { toggleLoggerBy } from "src/core/utils";
import { BackupFeature } from "src/features/backup/backup-feature";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import { StartupPolicyFeature } from "src/features/startup-policy/startup-policy-feature";
import { CoreContainer } from "src/services/core-container";
import { SettingsTab } from "src/ui/settings-tab";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    // Assigned during onload via loadSettings().
    data!: LazySettings;
    // Assigned during onload via loadSettings().
    settings!: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    core!: CoreContainer;
    features!: FeatureManager;
    events!: EventBus;

    async onload() {
        const ctx = createPluginContext(this);
        this.core = new CoreContainer(ctx);
        this.events = new EventBus();

        this.features = new FeatureManager(ctx, this.core, this.events);
        this.features.register(new BackupFeature());
        this.features.register(new MaintenanceFeature());
        this.features.register(new LazyEngineFeature());
        this.features.register(new StartupPolicyFeature());

        await this.loadSettings();
        this.configureLogger();

        // Registry needs to update manifests after settings are loaded
        this.core.registry.reloadManifests();
        this.updateManifests();

        // Full initialization (patches, command cache, view loader, etc.)
        await this.core.initialize();

        await this.features.loadAll();

        this.registerEventHandlers();

        this.addSettingTab(new SettingsTab(this.app, this));
    }

    private registerEventHandlers() {
        this.events.on(FeatureEvents.REBUILD_CACHE_REQUESTED, async (options: { force?: boolean }) => {
            const force = options?.force ?? false;
            const manifests = this.manifests;
            const lazyCount = manifests.filter((p) => this.getPluginMode(p.id) !== PLUGIN_MODE.ALWAYS_ENABLED && this.getPluginMode(p.id) !== PLUGIN_MODE.ALWAYS_DISABLED).length;

            const progress = new ProgressDialog(this.app, {
                title: "Rebuilding command cache",
                total: Math.max(1, lazyCount) + 2,
                cancellable: true,
                cancelText: "Cancel",
                onCancel: () => {},
            });
            progress.open();

            const lazyEngine = this.features.get(LazyEngineFeature);
            if (lazyEngine) {
                await lazyEngine.commandCache.refreshCommandCache(undefined, force, (current, total, plugin) => {
                    progress.setStatus(`Rebuilding ${plugin.name}`);
                    progress.setProgress(current, total);
                });
            }

            const policyFeature = this.features.get(StartupPolicyFeature);
            if (policyFeature) {
                await policyFeature.applyWithProgress(progress);
            }

            if (lazyEngine) {
                lazyEngine.commandCache.registerCachedCommands();
            }
        });

        this.events.on(FeatureEvents.APPLY_POLICIES_REQUESTED, async (options: { pluginIds?: string[] }) => {
            const policyFeature = this.features.get(StartupPolicyFeature);
            if (policyFeature) {
                await policyFeature.applyWithProgress(null, options?.pluginIds);
            }
        });
    }

    onunload() {
        void this.features?.unloadAll();
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

    async saveSettings() {
        await this.core.settingsService.save();
        this.app.workspace.trigger("ondemand-plugins:settings-saved");
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

        if (hasChanges) {
            await this.saveSettings();
        }
    }

    async updatePluginSettings(pluginId: string, mode: PLUGIN_MODE) {
        this.settings.plugins[pluginId] = { mode, userConfigured: true };
        await this.saveSettings();
        const lazyEngine = this.features.get(LazyEngineFeature);
        await lazyEngine!.applyPluginState(pluginId);
    }

    async applyStartupPolicyAndRestart(pluginIds?: string[]) {
        const policyFeature = this.features.get(StartupPolicyFeature);
        if (policyFeature) {
            await policyFeature.applyWithProgress(null, pluginIds);
        }
    }

    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        const maintenance = this.features.get(MaintenanceFeature);
        if (maintenance) {
            await maintenance.rebuildAndApplyCommandCache(options);
        }
    }

    async switchProfile(profileId: string) {
        this.core.settingsService.switchProfile(profileId);
        this.settings = this.core.settingsService.settings;
        await this.saveSettings();
        const policyFeature = this.features.get(StartupPolicyFeature);
        await policyFeature?.applyWithProgress(null);
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
