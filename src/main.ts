import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { Plugin } from "obsidian";
import { createPluginContext } from "./core/plugin-context";
import type { DeviceSettings, LazySettings, PluginMode } from "./core/types";
import { PLUGIN_MODE } from "./core/types";
import { toggleLoggerBy } from "./core/utils";
import { ServiceContainer } from "./services/service-container";
import { SettingsTab } from "./services/settings/settings-tab";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    container!: ServiceContainer;

    async onload() {
        const ctx = createPluginContext(this);
        this.container = new ServiceContainer(ctx);

        await this.loadSettings();
        this.configureLogger();

        // Registry needs to update manifests after settings are loaded
        this.container.registry.updateManifests();
        this.updateManifests();

        // Full initialization (patches, command cache, view loader, etc.)
        await this.container.initialize();

        this.addSettingTab(new SettingsTab(this.app, this));
    }

    onunload() {
        this.container?.destroy();
    }

    // ─── Settings ──────────────────────────────────────────────

    async loadSettings() {
        await this.container.settingsService.load();
        this.data = this.container.settingsService.data;
        this.settings = this.container.settingsService.settings;
        const profileId = this.container.settingsService.currentProfileId;
        this.device = this.container.settingsService.data.profiles[profileId]?.name ?? "Unknown";
    }

    async saveSettings() {
        await this.container.settingsService.save();
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
        await this.container.applyPluginState(pluginId);
    }

    async switchProfile(profileId: string) {
        await this.container.settingsService.switchProfile(profileId);
        this.settings = this.container.settingsService.settings;
        await this.saveSettings();
        await this.applyStartupPolicyAndRestart();
    }

    updateManifests() {
        this.container.registry.updateManifests();
        this.manifests = this.container.registry.manifests;
    }

    getPluginMode(pluginId: string): PluginMode {
        return this.settings.plugins?.[pluginId]?.mode ?? this.getDefaultModeForPlugin(pluginId);
    }

    getDefaultModeForPlugin(pluginId: string): PluginMode {
        if (this.isPluginEnabledOnDisk(pluginId)) {
            return PLUGIN_MODE.ALWAYS_ENABLED;
        }
        return PLUGIN_MODE.ALWAYS_DISABLED;
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return this.container.registry.isPluginEnabledOnDisk(pluginId);
    }

    // ─── Delegated operations ──────────────────────────────────

    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        await this.container.rebuildAndApplyCommandCache(options);
    }

    async rebuildCommandCache(
        pluginIds: string[],
        options?: {
            force?: boolean;
            onProgress?: (current: number, total: number, plugin: PluginManifest) => void;
        },
    ) {
        await this.container.rebuildCommandCache(pluginIds, options);
    }

    getCommandPluginId(commandId: string): string | null {
        const [prefix] = commandId.split(":");
        return this.manifests.some((plugin) => plugin.id === prefix) ? prefix : null;
    }

    async applyStartupPolicyAndRestart(pluginIds?: string[]) {
        await this.container.applyStartupPolicy(pluginIds);
    }

    configureLogger(): void {
        const level = this.data.showConsoleLog ? "debug" : "error";
        toggleLoggerBy(level, (name) => name.startsWith("OnDemandPlugin/"));
        logger.debug("Debug mode enabled");
    }
}
