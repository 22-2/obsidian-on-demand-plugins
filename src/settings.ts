import {
    App,
    ButtonComponent,
    DropdownComponent,
    PluginSettingTab,
    Setting,
    Notice,
} from "obsidian";
import LazyPlugin from "./main";

export interface PluginSettings {
    mode?: PluginMode;
    userConfigured?: boolean;
}

// Settings per device (desktop/mobile)
export interface DeviceSettings {
    defaultMode: PluginMode;
    showDescriptions: boolean;
    reRegisterLazyCommandsOnDisable: boolean;
    plugins: { [pluginId: string]: PluginSettings };
    lazyWithViews?: Record<string, string[]>;

    [key: string]: any;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
    defaultMode: "disabled",
    showDescriptions: true,
    reRegisterLazyCommandsOnDisable: true,
    plugins: {},
    lazyWithViews: {},
};

// Global settings for the plugin
export interface LazySettings {
    dualConfigs: boolean;
    showConsoleLog: boolean;
    desktop: DeviceSettings;
    mobile?: DeviceSettings;
    commandCache?: CommandCache;
    commandCacheVersions?: CommandCacheVersions;
    commandCacheUpdatedAt?: number;
}

export const DEFAULT_SETTINGS: LazySettings = {
    dualConfigs: false,
    showConsoleLog: false,
    desktop: DEFAULT_DEVICE_SETTINGS,
};

export interface CachedCommandEntry {
    id: string;
    name: string;
    icon?: string;
}

export type CommandCache = Record<string, CachedCommandEntry[]>;
export type CommandCacheVersions = Record<string, string>;

export type PluginMode = "disabled" | "lazy" | "keepEnabled" | "lazyWithView";

export const PluginModes: Record<PluginMode, string> = {
    disabled: "⛔ Disabled",
    lazy: "💤 Lazy (cache commands)",
    lazyWithView: "🖼️ Lazy with View",
    keepEnabled: "✅ Keep enabled",
};

export class SettingsTab extends PluginSettingTab {
    app: App;
    lazyPlugin: LazyPlugin;
    dropdowns: DropdownComponent[] = [];
    filterMethod: PluginMode | undefined;
    filterString: string | undefined;
    containerEl: HTMLElement;
    pluginListContainer: HTMLElement;
    pluginSettings: { [pluginId: string]: PluginSettings } = {};
    pendingPluginIds = new Set<string>();
    applyButton?: ButtonComponent;

    constructor(app: App, plugin: LazyPlugin) {
        super(app, plugin);
        this.app = app;
        this.lazyPlugin = plugin;
        this.pluginSettings = this.lazyPlugin.settings.plugins;
    }

    async display() {
        const { containerEl } = this;
        this.containerEl = containerEl;

        // Update the list of installed plugins
        this.lazyPlugin.updateManifests();

        // Load the settings from disk when the settings modal is displayed.
        // This avoids the issue where someone has synced the settings from another device,
        // but since the plugin has already been loaded, the new settings do not show up.
        await this.lazyPlugin.loadSettings();
        this.pluginSettings = this.lazyPlugin.settings.plugins;
        
        // Set initial configuration for any newly installed plugins
        await this.lazyPlugin.setInitialPluginsConfiguration();
        
        this.pendingPluginIds.clear();

        this.buildDom();
    }

    /**
     * Build the Settings modal DOM elements
     */
    buildDom() {
        this.containerEl.empty();
        this.dropdowns = [];

        new Setting(this.containerEl)
            .setName("Separate desktop/mobile configuration")
            .setDesc(
                "Enable this if you want to have different settings depending whether you're using a desktop or mobile device. " +
                    `All of the settings below can be configured differently on desktop and mobile. You're currently using the ${this.lazyPlugin.device} settings.`,
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.lazyPlugin.data.dualConfigs)
                    .onChange(async (value) => {
                        this.lazyPlugin.data.dualConfigs = value;
                        await this.lazyPlugin.saveSettings();
                        // Refresh the settings to make sure the mobile section is configured
                        await this.lazyPlugin.loadSettings();
                        this.buildDom();
                    });
            });

        new Setting(this.containerEl)
            .setName("Lazy command caching")
            .setHeading();

        new Setting(this.containerEl)
            .setName("Default behavior for new plugins")
            .addDropdown((dropdown) => {
                this.addModeOptions(dropdown);
                dropdown
                    .setValue(
                        this.lazyPlugin.settings.defaultMode || "disabled",
                    )
                    .onChange(async (value: PluginMode) => {
                        this.lazyPlugin.settings.defaultMode = value;
                        await this.lazyPlugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName("Show plugin descriptions")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.lazyPlugin.settings.showDescriptions)
                    .onChange(async (value) => {
                        this.lazyPlugin.settings.showDescriptions = value;
                        await this.lazyPlugin.saveSettings();
                        this.buildDom();
                    });
            });

        new Setting(this.containerEl)
            .setName("Re-register lazy commands on disable")
            .setDesc(
                "When a lazy plugin is manually disabled, re-register its cached command wrappers so the commands remain available.",
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(
                        this.lazyPlugin.settings
                            .reRegisterLazyCommandsOnDisable,
                    )
                    .onChange(async (value) => {
                        this.lazyPlugin.settings.reRegisterLazyCommandsOnDisable =
                            value;
                        await this.lazyPlugin.saveSettings();
                    });
            });

        // new Setting(this.containerEl)
        //   .setName("Register lazy plugins in bulk")
        //   .addDropdown((dropdown) => {
        //     dropdown.addOption("", "Set all plugins to be:");
        //     this.addModeOptions(dropdown);
        //     dropdown.onChange(async (value: PluginMode) => {
        //       // Update all plugins and defer apply until user confirms
        //       this.lazyPlugin.manifests.forEach((plugin) => {
        //         this.pluginSettings[plugin.id] = {
        //           mode: value,
        //           userConfigured: true,
        //         };
        //         this.pendingPluginIds.add(plugin.id);
        //       });
        //       // Update all the dropdowns
        //       this.dropdowns.forEach((dropdown) => dropdown.setValue(value));
        //       dropdown.setValue("");
        //       this.updateApplyButton();
        //     });
        //   });

        new Setting(this.containerEl)
            .setName("Apply pending changes")
            .setDesc("Plugin mode changes are queued until you apply them.")
            .addButton((button) => {
                this.applyButton = button;
                button.setButtonText("Apply changes");
                button.onClick(async () => {
                    if (this.pendingPluginIds.size === 0) return;
                    this.normalizeLazyWithViews();
                    await this.lazyPlugin.saveSettings();
                    await this.lazyPlugin.applyStartupPolicy(true);
                    this.pendingPluginIds.clear();
                    this.updateApplyButton();
                });
                this.updateApplyButton();
            });

        new Setting(this.containerEl)
            .setName("Force rebuild command cache")
            .setDesc("Force a rebuild of the cached commands for lazy plugins.")
            .addButton((button) => {
                button.setButtonText("Rebuild cache");
                button.onClick(async () => {
                    button.setDisabled(true);
                    try {
                        await this.lazyPlugin.initializeCommandCache();
                        new Notice("Command cache rebuilt");
                    } catch (e) {
                        new Notice("Failed to rebuild command cache");
                        // eslint-disable-next-line no-console
                        console.error(e);
                    } finally {
                        button.setDisabled(false);
                    }
                });
            });

        // Add the filter buttons
        new Setting(this.containerEl)
            .setName("Plugins (register lazy ones here)")
            .setHeading()
            .setDesc("Filter by: ")
            // Add the buttons to filter by startup method
            .then((setting) => {
                this.addFilterButton(setting.descEl, "All");
                Object.keys(PluginModes).forEach((key) =>
                    this.addFilterButton(
                        setting.descEl,
                        PluginModes[key as PluginMode],
                        key as PluginMode,
                    ),
                );
            });
        new Setting(this.containerEl)
            // Add a free-text filter
            .addText((text) =>
                text.setPlaceholder("Type to filter list").onChange((value) => {
                    this.filterString = value;
                    this.buildPluginList();
                }),
            );

        // Add an element to contain the plugin list
        this.pluginListContainer = this.containerEl.createEl("div");
        this.buildPluginList();
    }

    buildPluginList() {
        this.pluginListContainer.textContent = "";
        // Add the delay settings for each installed plugin
        this.lazyPlugin.manifests.forEach((plugin) => {
            const currentValue = this.lazyPlugin.getPluginMode(plugin.id);

            // Filter the list of plugins if there is a filter specified
            if (this.filterMethod && currentValue !== this.filterMethod) return;
            if (
                this.filterString &&
                !plugin.name
                    .toLowerCase()
                    .includes(this.filterString.toLowerCase())
            )
                return;

            const setting = new Setting(this.pluginListContainer)
                .setName(plugin.name)
                .addDropdown((dropdown) => {
                    this.dropdowns.push(dropdown);
                    this.addModeOptions(dropdown);
                    dropdown
                        .setValue(currentValue)
                        .onChange(async (value: PluginMode) => {
                            // Update the config, and defer apply until user confirms
                            this.pluginSettings[plugin.id] = {
                                mode: value,
                                userConfigured: true,
                            };
                            this.ensureLazyWithViewEntry(plugin.id, value);
                            this.pendingPluginIds.add(plugin.id);
                            this.updateApplyButton();
                            this.buildPluginList(); // Rebuild to show/hide view types input
                        });
                });

            // if (currentValue === "lazyWithView") {
            //   setting.addText((text) => {
            //     text
            //       .setPlaceholder("view-type-1, view-type-2")
            //       .setValue(
            //         (this.lazyPlugin.settings.lazyWithViews?.[plugin.id] || []).join(
            //           ", ",
            //         ),
            //       )
            //       .onChange(async (value) => {
            //         const viewTypes = value
            //           .split(",")
            //           .map((t) => t.trim())
            //           .filter((t) => t.length > 0);
            //         if (!this.lazyPlugin.settings.lazyWithViews) {
            //           this.lazyPlugin.settings.lazyWithViews = {};
            //         }
            //         this.lazyPlugin.settings.lazyWithViews[plugin.id] = viewTypes;
            //         await this.lazyPlugin.saveSettings();
            //       });
            //   });
            // }

            setting.then((setting) => {
                if (this.lazyPlugin.settings.showDescriptions) {
                    // Show or hide the plugin description depending on the user's choice
                    setting.setDesc(plugin.description);
                }
            });
        });
    }

    private ensureLazyWithViewEntry(pluginId: string, mode: PluginMode) {
        if (!this.lazyPlugin.settings.lazyWithViews) {
            this.lazyPlugin.settings.lazyWithViews = {};
        }
        if (mode === "lazyWithView") {
            if (!this.lazyPlugin.settings.lazyWithViews[pluginId]) {
                this.lazyPlugin.settings.lazyWithViews[pluginId] = [];
            }
            return;
        }

        if (this.lazyPlugin.settings.lazyWithViews[pluginId]) {
            delete this.lazyPlugin.settings.lazyWithViews[pluginId];
        }
    }

    private normalizeLazyWithViews() {
        if (!this.lazyPlugin.settings.lazyWithViews) {
            this.lazyPlugin.settings.lazyWithViews = {};
        }

        const lazyWithViews = this.lazyPlugin.settings.lazyWithViews;
        this.lazyPlugin.manifests.forEach((plugin) => {
            const mode = this.lazyPlugin.getPluginMode(plugin.id);
            if (mode === "lazyWithView") {
                if (!lazyWithViews[plugin.id]) {
                    lazyWithViews[plugin.id] = [];
                }
                return;
            }

            if (lazyWithViews[plugin.id]) {
                delete lazyWithViews[plugin.id];
            }
        });
    }

    /**
     * Add the dropdown select options for each delay type
     */
    addModeOptions(el: DropdownComponent) {
        Object.keys(PluginModes).forEach((key) => {
            el.addOption(key, PluginModes[key as PluginMode]);
        });
    }

    /**
     * Add a filter button in the header of the plugin list
     */
    addFilterButton(el: HTMLElement, text: string, value?: PluginMode) {
        const link = el.createEl("button", { text });
        link.addClass("lazy-plugin-filter");
        link.onclick = () => {
            this.filterMethod = value;
            this.buildPluginList();
        };
    }

    updateApplyButton() {
        if (!this.applyButton) return;
        const count = this.pendingPluginIds.size;
        this.applyButton.setDisabled(count === 0);
        this.applyButton.setButtonText(
            count === 0 ? "Apply changes" : `Apply changes (${count})`,
        );
    }
}
