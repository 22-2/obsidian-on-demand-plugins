import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { Plugin } from "obsidian";
import { createPluginContext } from "./core/plugin-context";
import type { DeviceSettings, LazySettings, PluginMode } from "./core/types";
import { PLUGIN_MODE } from "./core/types";
import { toggleLoggerBy } from "./core/utils";
import { FeatureManager } from "./core/feature-manager";
import { BackupFeature } from "./features/backup/backup-feature";
import { CoreContainer } from "./services/core-container";
import { SettingsTab } from "./services/settings/settings-tab";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    core!: CoreContainer;
    features!: FeatureManager;

    async onload() {
        const ctx = createPluginContext(this);
        this.core = new CoreContainer(ctx);
        
        this.features = new FeatureManager(ctx, this.core);
        this.features.register(new BackupFeature());

        await this.loadSettings();
        this.configureLogger();

        // Registry needs to update manifests after settings are loaded
        this.core.registry.reloadManifests();
        this.updateManifests();

        // Full initialization (patches, command cache, view loader, etc.)
        await this.core.initialize();

        await this.features.loadAll();

        this.addSettingTab(new SettingsTab(this.app, this));
    }

    onunload() {
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

    async saveSettings() {
        await this.core.settingsService.save();
        // @ts-expect-error - custom event
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

    async updatePluginSettings(pluginId: string, mode: PluginMode) {
        this.settings.plugins[pluginId] = { mode, userConfigured: true };
        await this.saveSettings();
        await this.core.applyPluginState(pluginId);
    }

    async switchProfile(profileId: string) {
        await this.core.settingsService.switchProfile(profileId);
        this.settings = this.core.settingsService.settings;
        await this.saveSettings();
        await this.applyStartupPolicyAndRestart();
    }

    updateManifests() {
        this.core.registry.reloadManifests();
        this.manifests = this.core.registry.manifests;
    }

    getPluginMode(pluginId: string): PluginMode {
        return this.settings.plugins?.[pluginId]?.mode ?? this.getDefaultModeForPlugin(pluginId);
    }

    getDefaultModeForPlugin(pluginId: string): PluginMode {
        if (this.isPluginEnabledOnDisk(pluginId)) {
            return PLUGIN_MODE.ALWAYS_ENABLED;
        }
        return this.settings.defaultMode;
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return this.core.registry.isPluginEnabledOnDisk(pluginId);
    }

    // ─── Delegated operations ──────────────────────────────────

    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        await this.core.rebuildAndApplyCommandCache(options);
    }

    async rebuildCommandCache(
        pluginIds: string[],
        options?: {
            force?: boolean;
            onProgress?: (current: number, total: number, plugin: PluginManifest) => void;
        },
    ) {
        await this.core.rebuildCommandCache(pluginIds, options);
    }

    getCommandPluginId(commandId: string): string | null {
        const [prefix] = commandId.split(":");
        return this.manifests.some((plugin) => plugin.id === prefix) ? prefix : null;
    }

    async applyStartupPolicyAndRestart(pluginIds?: string[]) {
        await this.core.applyStartupPolicy(pluginIds);
    }

    configureLogger(): void {
        const level = this.data.showConsoleLog ? "debug" : "error";
        toggleLoggerBy(level, (name) => name.startsWith("OnDemandPlugin/"));
        logger.debug("Debug mode enabled");
    }
}
