import log from "loglevel";
import type { App, ButtonComponent, DropdownComponent } from "obsidian";
import { ExtraButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import { showConfirmModal } from "../../core/confirm-modal";
import type { PluginMode, PluginSettings } from "../../core/types";
import { PluginModes } from "../../core/types";
import { isLazyMode } from "../../core/utils";
import type OnDemandPlugin from "../../main";
import { ToolsModal } from "../../ui/modals/tools-modal";
import { LazyOptionsModal } from "./lazy-options-modal";
import { ProfileManagerModal } from "./profile-manager-modal";

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
    isDirty = false;
    applyButton?: ButtonComponent;
    discardButton?: ButtonComponent;
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

        // Load settings to ensure we have the latest profiles
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

        // --- Profile Management Section ---
        const profileContainer = this.containerEl.createDiv("lazy-settings-profile-container");

        new Setting(profileContainer)
            .setName("Active profile")
            .setDesc("Select the active profile. Switching profiles will immediately apply the new configuration.")
            .addDropdown((dropdown) => {
                const profiles = this.plugin.data.profiles;
                Object.values(profiles).forEach((p) => {
                    dropdown.addOption(p.id, p.name);
                });
                dropdown.setValue(this.plugin.container.settingsService.currentProfileId);
                dropdown.onChange(async (newProfileId) => {
                    const currentId = this.plugin.container.settingsService.currentProfileId;
                    if (newProfileId === currentId) return;

                    // If dirty, ask for confirmation
                    if (this.isDirty || this.pendingPluginIds.size > 0) {
                        const confirm = await showConfirmModal(this.app, {
                            message: "You have unsaved changes in the current profile. If you switch now, these changes will be lost. Switch anyway?",
                        });
                        if (confirm !== true) {
                            dropdown.setValue(currentId);
                            return;
                        }
                    }

                    // Use the managed switchProfile method which updates references and saves
                    this.isDirty = false;
                    this.pendingPluginIds.clear();
                    new Notice(`Switched to profile: ${profiles[newProfileId].name}`);
                    await this.plugin.switchProfile(newProfileId);
                    this.display(); // Rebuild everything for the new profile
                });
            })
            .addExtraButton((btn) => {
                btn.setIcon("settings")
                    .setTooltip("Manage profiles")
                    .onClick(() => {
                        new ProfileManagerModal(
                            this.app,
                            this.plugin.container.settingsService, // Access via container to get the instance
                            // Callback on change
                            async () => {
                                await this.plugin.saveSettings();
                                this.buildDom(); // Refresh dropdown
                            },
                        ).open();
                    });
            });

        // Show which profile is default for current device
        const currentId = this.plugin.container.settingsService.currentProfileId;
        const isDesktopDefault = this.plugin.data.desktopProfileId === currentId;
        const isMobileDefault = this.plugin.data.mobileProfileId === currentId;

        if (isDesktopDefault || isMobileDefault) {
            const badges = [];
            if (isDesktopDefault) badges.push("Desktop default");
            if (isMobileDefault) badges.push("Mobile default");

            const infoEl = profileContainer.createEl("div", { cls: "lazy-profile-badges" });
            infoEl.setText(`Current profile is set as: ${badges.join(", ")}`);
        }

        // --- Standard Settings ---

        new Setting(this.containerEl)
            .setName("Debug log output")
            .setDesc("Enable detailed logs for troubleshooting.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.data.showConsoleLog).onChange((value) => {
                    this.plugin.data.showConsoleLog = value;
                    this.isDirty = true;
                    this.updateApplyButton();
                });
            });

        new Setting(this.containerEl).setName("Lazy command caching").setHeading();

        new Setting(this.containerEl)
            .setName("Default mode")
            .setDesc("Specify the default mode for newly discovered plugins or those not yet configured.")
            .addDropdown((dropdown) => {
                this.addModeOptions(dropdown);
                dropdown.setValue(this.plugin.settings.defaultMode).onChange((value: PluginMode) => {
                    this.plugin.settings.defaultMode = value;
                    this.isDirty = true;
                    this.updateApplyButton();
                });
            });

        new Setting(this.containerEl)
            .setName("Maintenance & batch operations")
            .setDesc("Rebuild command cache, sync with Obsidian settings, or batch-update plugin modes.")
            .addButton((button) => {
                button.setButtonText("Open Tools");
                button.onClick(() => {
                    new ToolsModal(this.app, this.plugin, () => {
                        this.buildDom();
                    }).open();
                });
            });

        new Setting(this.containerEl)
            .setName("Profile changes")
            .setDesc("Settings and plugin mode changes are queued until you save them.")
            .addButton((button) => {
                this.applyButton = button;
                button.setButtonText("Save changes");
                button.setCta();
                button.onClick(async () => {
                    const count = this.pendingPluginIds.size;
                    this.normalizelazyOnViews();
                    await this.plugin.saveSettings();
                    this.plugin.configureLogger(); // Apply log level immediately

                    if (count > 0) {
                        await this.plugin.applyStartupPolicyAndRestart(Array.from(this.pendingPluginIds));
                    } else {
                        new Notice("Settings saved");
                    }

                    this.isDirty = false;
                    this.pendingPluginIds.clear();
                    this.updateApplyButton();
                });
            })
            .addButton((button) => {
                this.discardButton = button;
                button.setButtonText("Discard");
                button.setTooltip("Discard unsaved changes");
                button.onClick(async () => {
                    if (await showConfirmModal(this.app, { message: "Are you sure you want to discard all unsaved changes?" })) {
                        await this.plugin.loadSettings();
                        this.isDirty = false;
                        this.pendingPluginIds.clear();
                        this.display();
                        new Notice("Changes discarded");
                    }
                });
            });

        this.updateApplyButton();

        // Plugin list header: results count, keyword filter, and filter dropdown (dropdown placed to the right of the keyword input)
        new Setting(this.containerEl)
            .setName("Plugins")
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
                    .forEach((key) => dropdown.addOption(key, PluginModes[key as PluginMode]));
                dropdown.setValue(this.filterMethod ?? "");
                dropdown.onChange((value: string) => {
                    this.filterMethod = value === "" ? undefined : (value as PluginMode);
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
            if (this.filterString && !plugin.name.toLowerCase().includes(this.filterString.toLowerCase())) return;

            count++;
            const setting = new Setting(this.pluginListContainer).setName(plugin.name);

            // Add gear button first (will appear on the left)
            const gearBtn = new ExtraButtonComponent(setting.controlEl)
                .setIcon("gear")
                .setTooltip("Advanced lazy options")
                .onClick(() => {
                    new LazyOptionsModal(this.app, this.plugin, plugin.id, () => {
                        this.pendingPluginIds.add(plugin.id);
                        this.updateApplyButton();
                        this.buildPluginList();
                    }).open();
                });

            // Only show for lazy modes
            const isLazy = isLazyMode(currentValue);
            gearBtn.extraSettingsEl.addClass("lazy-plugin-gear-left");
            if (isLazy) {
                gearBtn.extraSettingsEl.addClass("lazy-plugin-gear-visible");
            } else {
                gearBtn.extraSettingsEl.removeClass("lazy-plugin-gear-visible");
            }

            // Then add dropdown (will appear to the right of gear)
            setting.addDropdown((dropdown) => {
                this.dropdowns.push(dropdown);
                this.addModeOptions(dropdown);
                dropdown.setValue(currentValue).onChange((value: PluginMode) => {
                    // Update the config, and defer apply until user confirms
                    this.pluginSettings[plugin.id] = {
                        mode: value,
                        userConfigured: true,
                    };
                    this.ensurelazyOnViewEntry(plugin.id, value);
                    this.pendingPluginIds.add(plugin.id);
                    this.isDirty = true;
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
        if (!this.applyButton || !this.discardButton) return;
        const count = this.pendingPluginIds.size;
        const hasChanges = this.isDirty || count > 0;

        this.applyButton.setDisabled(!hasChanges);
        this.discardButton.setDisabled(!hasChanges);

        if (count > 0) {
            this.applyButton.setButtonText(`Save & Apply (${count}) & restart Obsidian`);
            this.applyButton.setWarning();
        } else {
            this.applyButton.setButtonText("Save changes");
            this.applyButton.buttonEl.removeClass("mod-warning");
        }
    }
}
