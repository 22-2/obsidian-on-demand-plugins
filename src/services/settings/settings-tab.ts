import log from "loglevel";
import {
    App,
    ButtonComponent,
    DropdownComponent,
    ExtraButtonComponent,
    Notice,
    PluginSettingTab,
    Setting,
} from "obsidian";
import type OnDemandPlugin from "../../main";
import { PluginMode, PluginModes, PluginSettings } from "../../core/types";
import { LazyOptionsModal } from "./lazy-options-modal";
import { isLazyMode } from "../../core/utils";

const logger = log.getLogger("OnDemandPlugin/SettingsTab");

export class SettingsTab extends PluginSettingTab {
    app: App;
    plugin: OnDemandPlugin;
    dropdowns: DropdownComponent[] = [];
    filterMethod: PluginMode | undefined;
    filterString: string | undefined;
    containerEl: HTMLElement;
    pluginListContainer: HTMLElement;
    pluginSettings: { [pluginId: string]: PluginSettings } = {};
    pendingPluginIds = new Set<string>();
    applyButton?: ButtonComponent;
    resultsCountEl?: HTMLElement;

    constructor(app: App, plugin: OnDemandPlugin) {
        super(app, plugin);
        this.app = app;
        this.plugin = plugin;
        this.pluginSettings = this.plugin.settings.plugins;
    }

    async display() {
        const { containerEl } = this;
        this.containerEl = containerEl;

        // Update the list of installed plugins
        this.plugin.updateManifests();

        // Load the settings from disk when the settings modal is displayed.
        // This avoids the issue where someone has synced the settings from another device,
        // but since the plugin has already been loaded, the new settings do not show up.
        await this.plugin.loadSettings();
        this.pluginSettings = this.plugin.settings.plugins;

        // Set initial configuration for any newly installed plugins
        await this.plugin.setupDefaultPluginConfigurations();

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
                    `All of the settings below can be configured differently on desktop and mobile. You're currently using the ${this.plugin.device} settings.`,
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.data.dualConfigs)
                    .onChange((value) => {
                        void (async () => {
                            this.plugin.data.dualConfigs = value;
                            await this.plugin.saveSettings();
                            // Refresh the settings to make sure the mobile section is configured
                            await this.plugin.loadSettings();
                            this.buildDom();
                        })();
                    });
            });

        new Setting(this.containerEl)
            .setName("Debug log output")
            .setDesc("Enable detailed logs for troubleshooting.")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.data.showConsoleLog)
                    .onChange((value) => {
                        this.plugin.data.showConsoleLog = value;
                        void (async () => {
                            await this.plugin.saveSettings();
                            this.plugin.configureLogger();
                        })();
                    });
            });

        new Setting(this.containerEl)
            .setName("Lazy command caching")
            .setHeading();

        // new Setting(this.containerEl)
        //     .setName("Show plugin descriptions")
        //     .addToggle((toggle) => {
        //         toggle
        //             .setValue(this.plugin.settings.showDescriptions)
        //             .onChange((value) => {
        //                 this.plugin.settings.showDescriptions = value;
        //                 void (async () => {
        //                     await this.plugin.saveSettings();
        //                     this.buildDom();
        //                 })();
        //             });
        //     });

        new Setting(this.containerEl)
            .setName("Re-register lazy commands/views wrapper on disable")
            .setDesc(
                "When a lazy plugin is manually disabled, re-register its cached command wrappers so the commands remain available. Applies to both 'Lazy on command' and 'Lazy on view' modes.",
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(
                        this.plugin.settings.reRegisterLazyCommandsOnDisable,
                    )
                    .onChange((value) => {
                        this.plugin.settings.reRegisterLazyCommandsOnDisable =
                            value;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName("Force rebuild command cache")
            .setDesc("Force a rebuild of the cached commands for lazy plugins.")
            .addButton((button) => {
                button.setButtonText("Rebuild cache");
                button.onClick(async () => {
                    button.setDisabled(true);
                    try {
                        await this.plugin.rebuildAndApplyCommandCache({
                            force: true,
                        });
                    } catch (e) {
                        new Notice("Failed to rebuild command cache");
                        logger.error(e);
                    } finally {
                        button.setDisabled(false);
                    }
                });
            });

        new Setting(this.containerEl)
            .setName("Apply pending changes")
            .setDesc("Plugin mode changes are queued until you apply them.")
            .addButton((button) => {
                this.applyButton = button;
                button.setButtonText("Apply changes");
                button.onClick(async () => {
                    if (this.pendingPluginIds.size === 0) return;
                    this.normalizelazyOnViews();
                    await this.plugin.saveSettings();
                    await this.plugin.applyStartupPolicy(
                        Array.from(this.pendingPluginIds),
                    );
                    this.pendingPluginIds.clear();
                    this.updateApplyButton();
                });
                this.updateApplyButton();
            });

        // Plugin list header: results count, keyword filter, and filter dropdown (dropdown placed to the right of the keyword input)
        new Setting(this.containerEl)
            .setName("Plugins (register lazy ones here)")
            .setHeading()
            .setDesc("Filter by: ")
            .then((setting) => {
                this.resultsCountEl = setting.controlEl.createEl("span", {
                    cls: "lazy-plugin-results-count",
                });
            })
            // Add a free-text filter first, then the dropdown appears to its right
            .addText((text) =>
                text.setPlaceholder("Type to filter list").onChange((value) => {
                    this.filterString = value;
                    this.buildPluginList();
                }),
            )
            .addDropdown((dropdown) => {
                // Empty key represents the "All" option
                dropdown.addOption("", "All");
                Object.keys(PluginModes)
                    .filter((key) => key !== "lazyOnView")
                    .forEach((key) =>
                        dropdown.addOption(key, PluginModes[key as PluginMode]),
                    );
                dropdown.setValue(this.filterMethod ?? "");
                dropdown.onChange((value: string) => {
                    this.filterMethod =
                        value === "" ? undefined : (value as PluginMode);
                    this.buildPluginList();
                });
            });

        // Add an element to contain the plugin list
        this.pluginListContainer = this.containerEl.createEl("div");
        this.buildPluginList();
    }

    buildPluginList() {
        this.pluginListContainer.textContent = "";
        let count = 0;
        // Add the delay settings for each installed plugin
        this.plugin.manifests.forEach((plugin) => {
            const currentValue = this.plugin.getPluginMode(plugin.id);

            // Filter the list of plugins if there is a filter specified
            if (this.filterMethod && currentValue !== this.filterMethod) return;
            if (
                this.filterString &&
                !plugin.name
                    .toLowerCase()
                    .includes(this.filterString.toLowerCase())
            )
                return;

            count++;
            const setting = new Setting(this.pluginListContainer).setName(
                plugin.name,
            );

            // Add gear button first (will appear on the left)
            const gearBtn = new ExtraButtonComponent(setting.controlEl)
                .setIcon("gear")
                .setTooltip("Advanced lazy options")
                .onClick(() => {
                    new LazyOptionsModal(
                        this.app,
                        this.plugin,
                        plugin.id,
                        () => {
                            this.pendingPluginIds.add(plugin.id);
                            this.updateApplyButton();
                            this.buildPluginList();
                        },
                    ).open();
                });

            // Only show for lazy modes
            const isLazy = isLazyMode(currentValue);
            gearBtn.extraSettingsEl.style.display = isLazy
                ? "inline-block"
                : "none";
            gearBtn.extraSettingsEl.addClass("lazy-plugin-gear-left");

            // Then add dropdown (will appear to the right of gear)
            setting.addDropdown((dropdown) => {
                this.dropdowns.push(dropdown);
                this.addModeOptions(dropdown);
                dropdown
                    .setValue(currentValue)
                    .onChange((value: PluginMode) => {
                        // Update the config, and defer apply until user confirms
                        this.pluginSettings[plugin.id] = {
                            mode: value,
                            userConfigured: true,
                        };
                        this.ensurelazyOnViewEntry(plugin.id, value);
                        this.pendingPluginIds.add(plugin.id);
                        this.updateApplyButton();
                        this.buildPluginList(); // Rebuild to show/hide view types input
                    });
            });

            setting.then((setting) => {
                if (this.plugin.settings.showDescriptions) {
                    // Show or hide the plugin description depending on the user's choice
                    setting.setDesc(plugin.description);
                }
            });
        });

        if (this.resultsCountEl) {
            this.resultsCountEl.setText(`${count} plugins`);
        }
    }

    private ensurelazyOnViewEntry(pluginId: string, mode: PluginMode) {
        if (!this.plugin.settings.lazyOnViews) {
            this.plugin.settings.lazyOnViews = {};
        }
        if (isLazyMode(mode)) {
            if (!this.plugin.settings.lazyOnViews[pluginId]) {
                this.plugin.settings.lazyOnViews[pluginId] = [];
            }
            return;
        }

        if (this.plugin.settings.lazyOnViews[pluginId]) {
            delete this.plugin.settings.lazyOnViews[pluginId];
        }
    }

    private normalizelazyOnViews() {
        if (!this.plugin.settings.lazyOnViews) {
            this.plugin.settings.lazyOnViews = {};
        }

        const lazyOnViews = this.plugin.settings.lazyOnViews;
        this.plugin.manifests.forEach((plugin) => {
            const mode = this.plugin.getPluginMode(plugin.id);
            if (isLazyMode(mode)) {
                if (!lazyOnViews[plugin.id]) {
                    lazyOnViews[plugin.id] = [];
                }
                return;
            }

            if (lazyOnViews[plugin.id]) {
                delete lazyOnViews[plugin.id];
            }
        });
    }

    /**
     * Add the dropdown select options for each delay type
     */
    addModeOptions(el: DropdownComponent) {
        Object.keys(PluginModes)
            .filter((key) => key !== "lazyOnView")
            .forEach((key) => {
                el.addOption(key, PluginModes[key as PluginMode]);
            });
    }

    /**
     * Add a filter button in the header of the plugin list
     */

    updateApplyButton() {
        if (!this.applyButton) return;
        const count = this.pendingPluginIds.size;
        this.applyButton.setDisabled(count === 0);
        this.applyButton.setButtonText(
            count === 0
                ? "Apply changes"
                : `Apply changes (${count}) & restart Obsidian`,
        );
    }
}
