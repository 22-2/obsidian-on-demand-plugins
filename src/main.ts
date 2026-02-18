import log from "loglevel";
import { Plugin, PluginManifest } from "obsidian";
import { ServiceContainer } from "./services/service-container";
import { createPluginContext } from "./core/plugin-context";
import { SettingsTab } from "./services/settings/settings-tab";
import { DeviceSettings, LazySettings, PluginMode } from "./core/types";
import { toggleLoggerBy } from "./core/utils";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];

    private container!: ServiceContainer;

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
        this.device = this.container.settingsService.device;
    }

    async saveSettings() {
        await this.container.settingsService.save();
    }

    async migrateSettings() {
        await this.container.settingsService.migrate();
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

            if (
                !current.userConfigured &&
                current.mode === "disabled" &&
                this.isPluginEnabledOnDisk(plugin.id)
            ) {
                this.settings.plugins[plugin.id] = {
                    mode: "keepEnabled",
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

    updateManifests() {
        this.container.registry.updateManifests();
        this.manifests = this.container.registry.manifests;
    }

    getPluginMode(pluginId: string): PluginMode {
        return (
            this.settings.plugins?.[pluginId]?.mode ??
            this.getDefaultModeForPlugin(pluginId)
        );
    }

    getDefaultModeForPlugin(pluginId: string): PluginMode {
        if (this.isPluginEnabledOnDisk(pluginId)) {
            return "keepEnabled";
        }
        return "disabled";
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
            onProgress?: (
                current: number,
                total: number,
                plugin: PluginManifest,
            ) => void;
        },
    ) {
        await this.container.rebuildCommandCache(pluginIds, options);
    }

    getCommandPluginId(commandId: string): string | null {
        const [prefix] = commandId.split(":");
        return this.manifests.some((plugin) => plugin.id === prefix)
            ? prefix
            : null;
    }

    async applyStartupPolicy(pluginIds?: string[]) {
        await this.container.applyStartupPolicy(pluginIds);
    }

    configureLogger(): void {
        const level = this.data.showConsoleLog ? "debug" : "error";
        toggleLoggerBy(level, (name) => name.startsWith("OnDemandPlugin/"));
        logger.debug("Debug mode enabled");
    }
}
