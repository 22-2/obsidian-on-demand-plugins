import { App, Modal, Setting, Notice, DropdownComponent } from "obsidian";
import type OnDemandPlugin from "../../main";
import { PluginMode, PluginModes, PLUGIN_MODE } from "../../core/types";

export class ToolsModal extends Modal {
    constructor(app: App, private plugin: OnDemandPlugin, private onComplete: () => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Tools" });

        // --- Sync Settings ---
        contentEl.createEl("h3", { text: "Sync settings" });
        const syncContainer = contentEl.createDiv("lazy-sync-container");

        let syncDirection: "coreToLazy" | "lazyToCore" = "coreToLazy";
        const previewEl = syncContainer.createEl("div", { cls: "lazy-sync-preview", attr: { style: "margin-bottom: 5px; font-weight: bold; text-align: center; border: 1px solid var(--background-modifier-border); padding: 5px; border-radius: 4px;" } });
        const summaryEl = syncContainer.createEl("div", { cls: "lazy-sync-summary", attr: { style: "margin-bottom: 15px; font-size: 0.85em; color: var(--text-muted); padding: 0 10px;" } });
        
        const updatePreview = async () => {
            await this.plugin.container.registry.loadEnabledPluginsFromDisk(this.plugin.data.showConsoleLog);
            const onDisk = this.plugin.container.registry.enabledPluginsFromDisk;
            const manifests = this.plugin.manifests;
            const lazySettings = this.plugin.settings.plugins;

            if (syncDirection === "coreToLazy") {
                previewEl.setText("📂 community-plugins.json ➔ ⚙️ On-Demand Plugins");
                
                const toEnable = manifests.filter(m => onDisk.has(m.id) && this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_DISABLED);
                const toDisable = manifests.filter(m => !onDisk.has(m.id) && this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED);
                
                let summary = `Enabled on disk: ${onDisk.size} plugins\n`;
                if (toEnable.length > 0) summary += `➕ Will set to Enabled: ${toEnable.length} (${toEnable.slice(0, 3).map(m => m.name).join(", ")}${toEnable.length > 3 ? "..." : ""})\n`;
                if (toDisable.length > 0) summary += `➖ Will set to Disabled: ${toDisable.length} (${toDisable.slice(0, 3).map(m => m.name).join(", ")}${toDisable.length > 3 ? "..." : ""})\n`;
                if (toEnable.length === 0 && toDisable.length === 0) summary += "✅ Already in sync";
                summaryEl.setText(summary);
                summaryEl.style.whiteSpace = "pre-wrap";
            } else {
                previewEl.setText("⚙️ On-Demand Plugins ➔ 📂 community-plugins.json");
                
                const alwaysEnabled = manifests.filter(m => this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED).map(m => m.id);
                if (!alwaysEnabled.includes(this.plugin.manifest.id)) alwaysEnabled.push(this.plugin.manifest.id);
                
                const toAdd = alwaysEnabled.filter(id => !onDisk.has(id));
                const toRemove = Array.from(onDisk).filter(id => !alwaysEnabled.includes(id) && manifests.some(m => m.id === id));
                
                let summary = `Always Enabled in Lazy: ${alwaysEnabled.length} plugins\n`;
                if (toAdd.length > 0) summary += `➕ Will enable in Obsidian: ${toAdd.length} (${toAdd.slice(0, 3).join(", ")}${toAdd.length > 3 ? "..." : ""})\n`;
                if (toRemove.length > 0) summary += `➖ Will disable in Obsidian: ${toRemove.length} (${toRemove.slice(0, 3).join(", ")}${toRemove.length > 3 ? "..." : ""})\n`;
                if (toAdd.length === 0 && toRemove.length === 0) summary += "✅ Already in sync";
                summaryEl.setText(summary);
                summaryEl.style.whiteSpace = "pre-wrap";
            }
        };
        updatePreview();

        new Setting(syncContainer)
            .setName("Sync direction")
            .setDesc("Choose which source should update the other.")
            .addDropdown((dropdown) => {
                dropdown.addOption("coreToLazy", "Obsidian config ➔ Plugin data");
                dropdown.addOption("lazyToCore", "Plugin data ➔ Obsidian config");
                dropdown.setValue(syncDirection).onChange((val: "coreToLazy" | "lazyToCore") => {
                    syncDirection = val;
                    updatePreview();
                });
            });

        new Setting(syncContainer)
            .addButton((btn) => {
                btn.setButtonText("Sync now").setClass("sync-button").setCta().onClick(async () => {
                    await this.plugin.container.registry.loadEnabledPluginsFromDisk(this.plugin.data.showConsoleLog);
                    let changed = 0;

                    if (syncDirection === "coreToLazy") {
                        // Obsidian config -> Plugin data
                        for (const manifest of this.plugin.manifests) {
                            const isEnabledOnDisk = this.plugin.container.registry.enabledPluginsFromDisk.has(manifest.id);
                            const currentMode = this.plugin.getPluginMode(manifest.id);
                            
                            let targetMode: PluginMode | null = null;
                            if (isEnabledOnDisk && currentMode === PLUGIN_MODE.ALWAYS_DISABLED) {
                               targetMode = PLUGIN_MODE.ALWAYS_ENABLED;
                            } else if (!isEnabledOnDisk && currentMode === PLUGIN_MODE.ALWAYS_ENABLED) {
                               targetMode = PLUGIN_MODE.ALWAYS_DISABLED;
                            }

                            if (targetMode) {
                                this.plugin.settings.plugins[manifest.id] = {
                                    mode: targetMode,
                                    userConfigured: true
                                };
                                changed++;
                            }
                        }
                        if (changed > 0) {
                            await this.plugin.saveSettings();
                            new Notice(`Synced ${changed} plugins TO On-Demand Plugins`);
                            this.onComplete();
                        } else {
                            new Notice("On-Demand Plugins is already in sync with Obsidian config");
                        }
                    } else {
                        // Plugin data -> Obsidian config (community-plugins.json)
                        const enabledInLazy = this.plugin.manifests
                            .filter(m => this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED)
                            .map(m => m.id);
                        
                        // We also need to keep other plugins that might not be in manifests (e.g. this plugin itself)
                        // but the registry usually handles the core file.
                        // Actually, we should probably just use what's in 'ALWAYS_ENABLED' plus the current plugin itself.
                        if (!enabledInLazy.includes(this.plugin.manifest.id)) {
                            enabledInLazy.push(this.plugin.manifest.id);
                        }

                        // Compare with what's currently on disk to see if we need to write
                        const currentOnDisk = Array.from(this.plugin.container.registry.enabledPluginsFromDisk);
                        const isSame = enabledInLazy.length === currentOnDisk.length && enabledInLazy.every(id => currentOnDisk.includes(id));

                        if (!isSame) {
                            await this.plugin.container.registry.writeCommunityPluginsFile(enabledInLazy, this.plugin.data.showConsoleLog);
                            new Notice(`Updated community-plugins.json based on Plugin data`);
                            // We don't necessarily need to reload UI as we only changed disk file
                            await this.plugin.container.registry.loadEnabledPluginsFromDisk(this.plugin.data.showConsoleLog);
                            this.onComplete();
                        } else {
                            new Notice("Obsidian config is already in sync with Plugin data");
                        }
                    }
                });
            });

        // --- Rebuild Command Cache ---
        new Setting(contentEl)
            .setName("Force rebuild command cache")
            .setDesc("Force a rebuild of the cached commands for lazy plugins.")
            .addButton((btn) => {
                btn.setButtonText("Rebuild cache").setWarning().onClick(async () => {
                    btn.setDisabled(true);
                    try {
                        await this.plugin.rebuildAndApplyCommandCache({ force: true });
                        new Notice("Command cache rebuilt successfully");
                    } catch (e) {
                        new Notice("Failed to rebuild command cache");
                    } finally {
                        btn.setDisabled(false);
                    }
                });
            });

        // --- Batch Replace Modes ---
        contentEl.createEl("h3", { text: "Batch replace modes" });
        const batchContainer = contentEl.createDiv("lazy-batch-replace-container");

        let fromMode: PluginMode = PLUGIN_MODE.ALWAYS_DISABLED;
        let toMode: PluginMode = PLUGIN_MODE.LAZY;

        new Setting(batchContainer)
            .setName("From mode")
            .addDropdown((dropdown) => {
                this.addModeOptions(dropdown);
                dropdown.setValue(fromMode).onChange((val: PluginMode) => fromMode = val);
            });

        new Setting(batchContainer)
            .setName("To mode")
            .addDropdown((dropdown) => {
                this.addModeOptions(dropdown);
                dropdown.setValue(toMode).onChange((val: PluginMode) => toMode = val);
            });

        new Setting(batchContainer)
            .addButton((btn) => {
                btn.setButtonText("Replace all").onClick(async () => {
                    if (fromMode === toMode) {
                        new Notice("Source and target modes are the same");
                        return;
                    }
                    let changed = 0;
                    for (const manifest of this.plugin.manifests) {
                        if (this.plugin.getPluginMode(manifest.id) === fromMode) {
                            this.plugin.settings.plugins[manifest.id] = {
                                mode: toMode,
                                userConfigured: true
                            };
                            changed++;
                        }
                    }
                    if (changed > 0) {
                        await this.plugin.saveSettings();
                        new Notice(`Updated ${changed} plugins from ${PluginModes[fromMode]} to ${PluginModes[toMode]}`);
                        this.onComplete();
                    } else {
                        new Notice(`No plugins found with mode: ${PluginModes[fromMode]}`);
                    }
                });
            });
    }

    private addModeOptions(dropdown: DropdownComponent) {
        Object.keys(PluginModes)
            .filter((key) => key !== "lazyOnView")
            .forEach((key) => dropdown.addOption(key, PluginModes[key as PluginMode]));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
