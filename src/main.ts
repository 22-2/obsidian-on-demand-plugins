import { Plugin, PluginManifest, WorkspaceLeaf, ViewState } from "obsidian";
import { CommandCacheService } from "./services/command-cache-service";
import { LazyCommandRunner } from "./services/lazy-command-runner";
import { PluginRegistry } from "./services/plugin-registry";
import { SettingsService } from "./services/settings-service";
import { StartupPolicyService } from "./services/startup-policy-service";
import { DeviceSettings, LazySettings, PluginMode, SettingsTab } from "./settings";

export default class LazyPlugin extends Plugin {
  data: LazySettings;
  settings: DeviceSettings;
  device = "desktop/global";
  manifests: PluginManifest[] = [];

  private settingsService!: SettingsService;
  private registry!: PluginRegistry;
  private commandCacheService!: CommandCacheService;
  private lazyRunner!: LazyCommandRunner;
  private startupPolicyService!: StartupPolicyService;

  get obsidianPlugins() {
    return (this.app as unknown as { plugins: any }).plugins;
  }

  get obsidianCommands() {
    return (this.app as unknown as { commands: any }).commands;
  }

  async onload() {
    this.settingsService = new SettingsService(this);
    await this.loadSettings();

    this.registry = new PluginRegistry(this.app, this.obsidianPlugins);
    await this.registry.loadEnabledPluginsFromDisk(this.data.showConsoleLog);
    this.updateManifests();

    this.lazyRunner = new LazyCommandRunner({
      app: this.app,
      obsidianCommands: this.obsidianCommands,
      obsidianPlugins: this.obsidianPlugins,
      getCachedCommand: (commandId) =>
        this.commandCacheService.getCachedCommand(commandId),
      removeCachedCommandsForPlugin: (pluginId) =>
        this.commandCacheService.removeCachedCommandsForPlugin(pluginId),
      getData: () => this.data,
    });

    this.commandCacheService = new CommandCacheService({
      obsidianCommands: this.obsidianCommands,
      obsidianPlugins: this.obsidianPlugins,
      getManifests: () => this.manifests,
      getPluginMode: (pluginId) => this.getPluginMode(pluginId),
      getCommandPluginId: (commandId) => this.getCommandPluginId(commandId),
      waitForPluginLoaded: (pluginId, timeoutMs) =>
        this.lazyRunner.waitForPluginLoaded(pluginId, timeoutMs),
      runLazyCommand: (commandId) => this.lazyRunner.runLazyCommand(commandId),
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
      getLazyWithViews: () => this.settings.lazyWithViews,
      saveLazyWithViews: async (next) => {
        this.settings.lazyWithViews = next;
        await this.saveSettings();
      },
      ensurePluginLoaded: (pluginId) =>
        this.lazyRunner.ensurePluginLoaded(pluginId),
      refreshCommandCache: () => this.commandCacheService.refreshCommandCache(),
    });

    await this.migrateSettings();
    await this.setInitialPluginsConfiguration();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.commandCacheService.loadFromData();
    await this.initializeCommandCache();

    this.patchSetViewState();
  }

  private patchSetViewState() {
    const plugin = this;
    const leafPrototype = WorkspaceLeaf.prototype as any;
    const originalSetViewState = leafPrototype.setViewState;

    leafPrototype.setViewState = async function (
      viewState: ViewState,
      ...args: any[]
    ) {
      const result = await originalSetViewState.apply(this, [viewState, ...args]);
      if (viewState?.type) {
        plugin.checkViewTypeForLazyLoading(viewState.type);
      }
      return result;
    };

    this.register(() => {
      leafPrototype.setViewState = originalSetViewState;
    });
  }

  async checkViewTypeForLazyLoading(viewType: string) {
    if (!viewType) return;

    const lazyWithViews = this.settings.lazyWithViews || {};
    for (const [pluginId, viewTypes] of Object.entries(lazyWithViews)) {
      if (viewTypes.includes(viewType)) {
        const mode = this.getPluginMode(pluginId);
        if (mode === "lazyWithView") {
          await this.lazyRunner.ensurePluginLoaded(pluginId);
        }
      }
    }
  }

  async onunload() {
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

  async applyStartupPolicy(showProgress = false) {
    await this.startupPolicyService.apply(showProgress);
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

    if (mode === "lazy" || mode === "lazyWithView") {
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
}
