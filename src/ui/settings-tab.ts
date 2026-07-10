import type { App, ButtonComponent, DropdownComponent } from "obsidian";
import { ExtraButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { FeatureEvents } from "src/core/event-bus";
import type { PluginSettings, PLUGIN_MODE } from "src/core/types";
import { PluginModes } from "src/core/types";
import { isLazyMode } from "src/core/utils";
import type OnDemandPlugin from "src/main";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";
import { ProfileManagerModal } from "src/ui/modals/profile-manager-modal";
import { ToolsModal } from "src/ui/modals/tools-modal";

export class SettingsTab extends PluginSettingTab {
    app: App;
    plugin: OnDemandPlugin;
    dropdowns: DropdownComponent[] = [];
    filterMethod: PLUGIN_MODE | undefined;
    filterString: string | undefined;
    // Created in buildDom() before buildPluginList() runs.
    pluginSectionContainer!: HTMLElement;
    pluginSectionContent!: HTMLElement;
    pluginListContainer!: HTMLElement;
    pluginToggleButton?: HTMLButtonElement;
    isPluginListOpen = false;
    pluginSettings: { [pluginId: string]: PluginSettings } = {};
    private pluginListBuilt = false;
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

    display(): void {
        const { containerEl } = this;
        this.containerEl = containerEl;

        // Update the list of installed plugins and render immediately.
        // Settings are already loaded during plugin startup, so avoid blocking
        // the settings UI on disk I/O when the tab is opened.
        this.plugin.updateManifests();
        this.pluginSettings = this.plugin.settings.plugins;
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
                dropdown.setValue(this.plugin.core.settingsService.currentProfileId);
                dropdown.onChange((newProfileId) => {
                    void this.handleProfileChange(newProfileId, dropdown);
                });
            })
            .addExtraButton((btn) => {
                btn.setIcon("settings")
                    .setTooltip("Manage profiles")
                    .onClick(() => {
                        new ProfileManagerModal(
                            this.app,
                            this.plugin.core.settingsService, // Access via core to get the instance
                            // Callback on change
                            () => {
                                void this.plugin.saveSettings();
                                this.buildDom(); // Refresh dropdown
                            },
                        ).open();
                    });
            });

        // Show which profile is default for current device
        const currentId = this.plugin.core.settingsService.currentProfileId;
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

        new Setting(this.containerEl).setName("Plugin behavior").setHeading();

        new Setting(this.containerEl)
            .setName("Default mode")
            .setDesc("Specify the default mode for newly discovered plugins or those not yet configured.")
            .addDropdown((dropdown) => {
                this.addModeOptions(dropdown);
                dropdown.setValue(this.plugin.settings.defaultMode).onChange((value: string) => {
                    this.plugin.settings.defaultMode = value as PLUGIN_MODE;
                    this.isDirty = true;
                    this.updateApplyButton();
                });
            });

        new Setting(this.containerEl)
            .setName("Auto-remove uninstalled entries")
            .setDesc("Prune the current profile's saved settings and command cache for plugins that are no longer installed. Cleanup runs at plugin startup and immediately when enabled.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.pruneUninstalledEntries).onChange((value) => {
                    this.plugin.settings.pruneUninstalledEntries = value;
                    // Prune immediately (backing up first) so the effect is visible at
                    // once; the deferred save flow persists it, avoiding an early save
                    // of other pending edits.
                    if (value) {
                        void this.plugin.backupAndPruneUninstalledEntries();
                    }
                    this.isDirty = true;
                    this.updateApplyButton();
                });
            });

        new Setting(this.containerEl)
            .setName("Maintenance and batch operations")
            .setDesc("Rebuild command cache, sync with Obsidian settings, or batch-update plugin modes.")
            .addButton((button) => {
                button.setButtonText("Open tools");
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
                button.onClick(() => {
                    void this.handleSaveChanges();
                });
            })
            .addButton((button) => {
                this.discardButton = button;
                button.setButtonText("Discard");
                button.setTooltip("Discard unsaved changes");
                button.onClick(() => {
                    void this.handleDiscardChanges();
                });
            });

        this.updateApplyButton();

        // Plugin list wrapper: heading, search, filter, and the list itself.
        this.pluginSectionContainer = this.containerEl.createDiv("lazy-plugin-section");

        const pluginToggleRow = this.pluginSectionContainer.createDiv("lazy-plugin-toggle-row");
        const toggleButton = pluginToggleRow.createEl("button", {
            cls: "mod-cta lazy-plugin-toggle-button",
            text: "0 plugins",
        });
        toggleButton.type = "button";
        toggleButton.addEventListener("click", () => {
            this.isPluginListOpen = !this.isPluginListOpen;
            this.updatePluginSectionVisibility();
        });
        this.pluginToggleButton = toggleButton;

        this.pluginSectionContent = this.pluginSectionContainer.createDiv("lazy-plugin-section-content");

        if (!this.isPluginListOpen) {
            this.pluginSectionContainer.classList.add("lazy-plugin-section-collapsed");
        }

        new Setting(this.pluginSectionContent)
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
                Object.keys(PluginModes).forEach((key) => {
                    dropdown.addOption(key, PluginModes[key as PLUGIN_MODE]);
                });
                dropdown.setValue(this.filterMethod ?? "");
                dropdown.onChange((value: string) => {
                    this.filterMethod = value === "" ? undefined : (value as PLUGIN_MODE);
                    this.buildPluginList();
                });
            });

        // Add an element to contain the plugin list
        this.pluginListContainer = this.pluginSectionContent.createEl("div", {
            cls: "lazy-plugin-list-body",
        });

        if (this.isPluginListOpen) {
            this.buildPluginList();
        } else {
            this.updatePluginToggleButton(this.plugin.manifests.length);
        }
    }

    private async handleProfileChange(newProfileId: string, dropdown: DropdownComponent): Promise<void> {
        const profiles = this.plugin.data.profiles;
        const currentId = this.plugin.core.settingsService.currentProfileId;
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
    }

    private async handleSaveChanges(): Promise<void> {
        const count = this.pendingPluginIds.size;
        this.normalizeLazyOnViews();
        await this.plugin.saveSettings();
        this.plugin.configureLogger(); // Apply log level immediately

        if (count > 0) {
            await this.plugin.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds: Array.from(this.pendingPluginIds) });
        } else {
            new Notice("Settings saved");
        }

        this.isDirty = false;
        this.pendingPluginIds.clear();
        this.updateApplyButton();
    }

    private async handleDiscardChanges(): Promise<void> {
        if (await showConfirmModal(this.app, { message: "Are you sure you want to discard all unsaved changes?" })) {
            await this.plugin.loadSettings();
            this.isDirty = false;
            this.pendingPluginIds.clear();
            this.display();
            new Notice("Changes discarded");
        }
    }

    buildPluginList() {
        this.pluginListBuilt = true;
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
                dropdown.setValue(currentValue).onChange((value: string) => {
                    // Update the config, and defer apply until user confirms
                    const mode = value as PLUGIN_MODE;
                    this.pluginSettings[plugin.id] = {
                        mode,
                        userConfigured: true,
                    };
                    this.ensureLazyViewEntry(plugin.id, mode);
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

        this.updatePluginToggleButton(this.plugin.manifests.length);
        this.updatePluginSectionVisibility();
    }

    private updatePluginToggleButton(count: number): void {
        if (!this.pluginToggleButton) return;
        this.pluginToggleButton.textContent = `${count} Plugins`;
    }

    private updatePluginSectionVisibility(): void {
        if (!this.pluginSectionContainer) return;
        if (this.isPluginListOpen) {
            this.pluginSectionContainer.classList.remove("lazy-plugin-section-collapsed");
            if (!this.pluginListBuilt) {
                setTimeout(() => {
                    if (this.isPluginListOpen && !this.pluginListBuilt) {
                        this.buildPluginList();
                    }
                }, 0);
            }
        } else {
            this.pluginSectionContainer.classList.add("lazy-plugin-section-collapsed");
        }
    }

    private ensureLazyViewEntry(pluginId: string, mode: PLUGIN_MODE) {
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

    private normalizeLazyOnViews() {
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
        Object.keys(PluginModes).forEach((key) => {
            el.addOption(key, PluginModes[key as PLUGIN_MODE]);
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
            this.applyButton.setButtonText(`Save & apply (${count}) & restart obsidian`);
            this.applyButton.setWarning();
        } else {
            this.applyButton.setButtonText("Save changes");
            this.applyButton.buttonEl.removeClass("mod-warning");
        }
    }
}
