import log from "loglevel";
import { Plugin, PluginManifest } from "obsidian";
import { Commands, Plugins } from "obsidian-typings";
import { CommandCacheService } from "./services/command-cache-service";
import { LazyCommandRunner } from "./services/lazy-command-runner";
import { PluginRegistry } from "./services/plugin-registry";
import { SettingsService } from "./services/settings-service";
import { StartupPolicyService } from "./services/startup-policy-service";
import { ViewLazyLoader } from "./services/view-lazy-loader";
import { patchPluginEnableDisable } from "./patches/plugin-enable-disable";
import { patchSetViewState } from "./patches/view-state";
import {
    DeviceSettings,
    LazySettings,
    PluginMode,
    SettingsTab,
} from "./settings";
import { toggleLoggerBy } from "./utils";

const logger = log.getLogger("OnDemandPlugin/OnDemandPlugin");

export default class OnDemandPlugin extends Plugin {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";
    manifests: PluginManifest[] = [];
    private layoutReady = false;

    private settingsService!: SettingsService;
    private registry!: PluginRegistry;
    private commandCacheService!: CommandCacheService;
    private lazyRunner!: LazyCommandRunner;
    private startupPolicyService!: StartupPolicyService;
    private viewLazyLoader!: ViewLazyLoader;

    get obsidianPlugins() {
        return (this.app as unknown as { plugins: Plugins }).plugins;
    }

    get obsidianCommands() {
        return (this.app as unknown as { commands: Commands }).commands;
    }

    async onload() {
        this.settingsService = new SettingsService(this);
        await this.loadSettings();
        this.configureLogger();

        this.registry = new PluginRegistry(this.app, this.obsidianPlugins);
        await this.registry.loadEnabledPluginsFromDisk(
            this.data.showConsoleLog,
        );
        this.updateManifests();

        this.lazyRunner = new LazyCommandRunner({
            app: this.app,
            obsidianCommands: this.obsidianCommands,
            obsidianPlugins: this.obsidianPlugins,
            getCachedCommand: (commandId) =>
                this.commandCacheService.getCachedCommand(commandId),
            removeCachedCommandsForPlugin: (pluginId) =>
                this.commandCacheService.removeCachedCommandsForPlugin(
                    pluginId,
                ),
            getData: () => this.data,
            isWrapperCommand: (commandId) =>
                this.commandCacheService.isWrapperCommand(commandId),
            syncCommandWrappersForPlugin: (pluginId) =>
                this.commandCacheService.syncCommandWrappersForPlugin(pluginId),
        });

        this.commandCacheService = new CommandCacheService({
            obsidianCommands: this.obsidianCommands,
            obsidianPlugins: this.obsidianPlugins,
            getManifests: () => this.manifests,
            getPluginMode: (pluginId) => this.getPluginMode(pluginId),
            getCommandPluginId: (commandId) =>
                this.getCommandPluginId(commandId),
            waitForPluginLoaded: (pluginId, timeoutMs) =>
                this.lazyRunner.waitForPluginLoaded(pluginId, timeoutMs),
            runLazyCommand: (commandId) =>
                this.lazyRunner.runLazyCommand(commandId),
            getData: () => this.data,
            saveSettings: () => this.saveSettings(),
        });

        this.startupPolicyService = new StartupPolicyService({
            app: this.app,
            obsidianPlugins: this.obsidianPlugins,
            getManifests: () => this.manifests,
            getPluginMode: (pluginId) => this.getPluginMode(pluginId),
            applyPluginState: (pluginId) => this.applyPluginState(pluginId),
            writeCommunityPluginsFile: (enabledPlugins) =>
                this.registry.writeCommunityPluginsFile(
                    enabledPlugins,
                    this.data?.showConsoleLog,
                ),
            getlazyOnViews: () => this.settings.lazyOnViews,
            savelazyOnViews: async (next) => {
                this.settings.lazyOnViews = next;
                await this.saveSettings();
            },
            ensurePluginLoaded: (pluginId) =>
                this.lazyRunner.ensurePluginLoaded(pluginId),
            refreshCommandCache: (pluginIds) =>
                this.commandCacheService.refreshCommandCache(pluginIds),
        });

        // await this.migrateSettings();
        this.addSettingTab(new SettingsTab(this.app, this));

        this.viewLazyLoader = new ViewLazyLoader({
            app: this.app,
            registerEvent: this.registerEvent.bind(this),
            getPluginMode: (pluginId) => this.getPluginMode(pluginId),
            getLazyOnViews: () => this.settings.lazyOnViews,
            ensurePluginLoaded: (pluginId) =>
                this.lazyRunner.ensurePluginLoaded(pluginId),
            syncCommandWrappersForPlugin: (pluginId) =>
                this.commandCacheService.syncCommandWrappersForPlugin(pluginId),
        });

        this.commandCacheService.loadFromData();
        this.commandCacheService.registerCachedCommands();
        patchPluginEnableDisable({
            register: this.register.bind(this),
            obsidianPlugins: this.obsidianPlugins,
            getPluginMode: (pluginId) => this.getPluginMode(pluginId),
            settings: this.settings,
            commandCacheService: this.commandCacheService,
        });
        // DO NOT CALL THIS HERE TO AVOID UNINTENDED BEHAVIOR ON STARTUP
        // await this.initializeCommandCache();
        patchSetViewState({
            register: this.register.bind(this),
            onViewType: (viewType) =>
                this.viewLazyLoader.checkViewTypeForLazyLoading(viewType),
        });
        this.viewLazyLoader.registerActiveLeafReload();
    }

    onunload() {
        this.commandCacheService?.clear();
        this.lazyRunner?.clear();
        this.registry?.clear();
    }

    async loadSettings() {
        if (!this.settingsService) {
            this.settingsService = new SettingsService(this);
        }
        await this.settingsService.load();
        this.data = this.settingsService.data;
        this.settings = this.settingsService.settings;
        this.device = this.settingsService.device;
    }

    async saveSettings() {
        await this.settingsService.save();
    }

    async migrateSettings() {
        await this.settingsService.migrate();
    }

    /**
     * Set the initial config value for all installed plugins. This will also set the value
     * for any new plugin in the future, depending on what default value is chosen in the
     * Settings page.
     */
    async setInitialPluginsConfiguration() {
        let hasChanges = false;
        for (const plugin of this.manifests) {
            const current = this.settings.plugins?.[plugin.id];
            if (!current || current.mode === undefined) {
                // There is no existing setting for this plugin, so create one
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

    /**
     * Update an individual plugin's configuration in the settings file
     */
    async updatePluginSettings(pluginId: string, mode: PluginMode) {
        this.settings.plugins[pluginId] = { mode, userConfigured: true };
        await this.saveSettings();
        await this.applyPluginState(pluginId);
    }

    updateManifests() {
        this.registry.updateManifests();
        this.manifests = this.registry.manifests;
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

        return this.settings.defaultMode ?? "disabled";
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return this.registry.isPluginEnabledOnDisk(pluginId);
    }

    async initializeCommandCache() {
        await this.commandCacheService.refreshCommandCache();
        await this.applyStartupPolicy();
        this.commandCacheService.registerCachedCommands();
    }

    getCommandPluginId(commandId: string): string | null {
        const [prefix] = commandId.split(":");
        return this.manifests.some((plugin) => plugin.id === prefix)
            ? prefix
            : null;
    }

    async applyStartupPolicy(showProgress = false, pluginIds?: string[]) {
        await this.startupPolicyService.apply(showProgress, pluginIds);
    }

    async applyPluginState(pluginId: string) {
        const mode = this.getPluginMode(pluginId);
        if (mode === "keepEnabled") {
            if (!this.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.obsidianPlugins.enablePlugin(pluginId);
                await this.lazyRunner.waitForPluginLoaded(pluginId);
            }
            this.commandCacheService.removeCachedCommandsForPlugin(pluginId);
            return;
        }

        if (mode === "lazy" || mode === "lazyOnView") {
            await this.commandCacheService.ensureCommandsCached(pluginId);
            if (this.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.obsidianPlugins.disablePlugin(pluginId);
            }
            this.commandCacheService.registerCachedCommandsForPlugin(pluginId);
            return;
        }

        if (this.obsidianPlugins.enabledPlugins.has(pluginId)) {
            await this.obsidianPlugins.disablePlugin(pluginId);
        }
        this.commandCacheService.removeCachedCommandsForPlugin(pluginId);
    }

    configureLogger(): void {
        const level = this.data.showConsoleLog ? "debug" : "error";
        toggleLoggerBy(level, (name) => name.startsWith("OnDemandPlugin/"));
        logger.debug("Debug mode enabled");
    }
}
