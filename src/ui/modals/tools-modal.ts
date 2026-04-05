import type { App, DropdownComponent } from "obsidian";
import { Modal, Notice, setIcon, Setting } from "obsidian";
import type { PluginMode } from "src/core/types";
import { PluginModes, PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";
import type { SyncDirection } from "src/features/maintenance/maintenance-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";

export class ToolsModal extends Modal {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private plugin: OnDemandPlugin;
    private onComplete: () => void;

    private fromMode: PluginMode = PLUGIN_MODE.ALWAYS_DISABLED;
    private toMode: PluginMode = PLUGIN_MODE.LAZY;
    private confirmTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    private activeTabId: string = "sync";
    private tabContentEl!: HTMLElement;

    constructor(
        app: App,
        plugin: OnDemandPlugin,
        onComplete: () => void,
    ) {
        super(app);
        this.plugin = plugin;
        this.onComplete = onComplete;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.setAttr("class", "lazy-tools-modal");

        new Setting(contentEl).setName("Maintenance tools").setHeading();

        const tabHeader = contentEl.createDiv({ cls: "lazy-tab-header" });
        this.tabContentEl = contentEl.createDiv({ cls: "lazy-tab-content" });

        this.createTab(tabHeader, "sync", "Sync", "refresh-cw");
        this.createTab(tabHeader, "batch", "Replace", "switch");
        this.createTab(tabHeader, "maintenance", "Maintenance", "database");
        this.createTab(tabHeader, "debug", "Debug", "command");

        this.renderActiveTab();

        const closeButtonContainer = contentEl.createDiv({
            cls: "modal-button-container",
        });

        new Setting(closeButtonContainer).addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
    }

    private createTab(headerEl: HTMLElement, id: string, label: string, icon: string) {
        const tabBtn = headerEl.createEl("button", {
            cls: ["lazy-tab-button", this.activeTabId === id ? "is-active" : ""],
        });
        
        const iconSpan = tabBtn.createSpan({ cls: "lazy-tab-button-icon" });
        setIcon(iconSpan, icon);
        tabBtn.createSpan({ text: label, cls: "lazy-tab-button-text" });

        tabBtn.onclick = () => {
            if (this.activeTabId === id) return;
            
            headerEl.querySelectorAll(".lazy-tab-button").forEach(el => el.removeClass("is-active"));
            tabBtn.addClass("is-active");
            
            this.activeTabId = id;
            this.renderActiveTab();
        };
    }

    private renderActiveTab() {
        this.tabContentEl.empty();

        switch (this.activeTabId) {
            case "sync":
                this.buildSyncSettingsSection(this.tabContentEl);
                break;
            case "batch":
                this.buildBatchReplaceModeSection(this.tabContentEl);
                break;
            case "maintenance":
                this.buildRebuildCacheSection(this.tabContentEl);
                break;
            case "debug":
                this.buildDebugSection(this.tabContentEl);
                break;
        }
    }

    onClose() {
        this.contentEl.empty();
    }

    // -------------------------------------------------------------------------
    // Section builders
    // -------------------------------------------------------------------------

    private buildSyncSettingsSection(container: HTMLElement) {
        new Setting(container).setName("Synchronize settings").setHeading();
        const previewContainer = container.createDiv({ cls: "lazy-sync-preview" });
        const previewLabel = previewContainer.createDiv({ cls: "lazy-sync-preview-label" });
        const previewSummary = previewContainer.createDiv({ cls: "lazy-sync-preview-summary" });

        const syncContainer = container.createDiv("lazy-sync-container");

        let syncDirection: SyncDirection = "lazyToCore";

        const refreshPreview = async () => {
            const feature = this.plugin.features.get(MaintenanceFeature);
            const result = await feature!.buildSyncPreview(syncDirection);
            previewLabel.setText(result.label);
            previewSummary.setText(result.summary);
        };

        void refreshPreview();

        new Setting(syncContainer)
            .setName("Sync direction")
            .setDesc("Choose which source should update the other.")
            .addDropdown((dropdown) => {
                dropdown
                .addOption("lazyToCore", "Plugin data -> Obsidian config")
                .addOption("coreToLazy", "Obsidian config -> plugin data")
                    .setValue(syncDirection)
                    .onChange((value: string) => {
                        syncDirection = value as SyncDirection;
                        void refreshPreview();
                    });
            });

        new Setting(syncContainer).addButton((btn) =>
            btn
                .setButtonText("Sync now")
                .setClass("sync-button")
                .setCta()
                .onClick(() => {
                    void (async () => {
                    const feature = this.plugin.features.get(MaintenanceFeature);
                    const result = await feature!.executeSync(syncDirection);
                    new Notice(result.message);
                    if (result.changed > 0) this.onComplete();
                    await refreshPreview();
                    })();
                }),
        );
    }

    private buildRebuildCacheSection(container: HTMLElement) {
        new Setting(container).setName("Cache maintenance").setHeading();
        new Setting(container)
            .setName("Force rebuild command cache")
            .setDesc("Force a rebuild of the cached commands for lazy plugins.")
            .addButton((btn) =>
                btn
                    .setButtonText("Rebuild cache")
                    .setWarning()
                    .onClick(() => {
                        void (async () => {
                        btn.setDisabled(true);
                        try {
                            const feature = this.plugin.features.get(MaintenanceFeature);
                            await (feature as MaintenanceFeature).rebuildAndApplyCommandCache({
                                force: true,
                            });
                            new Notice("Command cache rebuilt successfully");
                        } catch {
                            new Notice("Failed to rebuild command cache");
                        } finally {
                            btn.setDisabled(false);
                        }
                        })();
                    }),
            );
    }

    private buildBatchReplaceModeSection(container: HTMLElement) {
        new Setting(container).setName("Batch replace mode").setHeading();
        const batchContainer = container.createDiv("lazy-batch-replace-container");

        new Setting(batchContainer).setName("From mode").addDropdown((dd) =>
            this.addModeOptions(dd)
                .setValue(this.fromMode)
                .onChange((value: string) => {
                    this.fromMode = value as PluginMode;
                }),
        );

        new Setting(batchContainer).setName("To mode").addDropdown((dd) =>
            this.addModeOptions(dd)
                .setValue(this.toMode)
                .onChange((value: string) => {
                    this.toMode = value as PluginMode;
                }),
        );
        
        new Setting(container).addButton((btn) =>
            btn
                .setButtonText("Replace all")
                .setClass("replace-button")
                .onClick(() => {
                    if (this.fromMode === this.toMode) {
                        new Notice("Source and target modes are the same");
                        return;
                    }

                    if (btn.buttonEl.innerText === "Replace all") {
                        btn.setButtonText("Click to confirm").setWarning();
                        if (this.confirmTimeout) globalThis.clearTimeout(this.confirmTimeout);
                        this.confirmTimeout = globalThis.setTimeout(() => {
                            btn.setButtonText("Replace all");
                            btn.buttonEl.removeClass("mod-warning");
                        }, 3000);
                        return;
                    }

                    if (this.confirmTimeout) {
                        globalThis.clearTimeout(this.confirmTimeout);
                        this.confirmTimeout = null;
                    }

                    const feature = this.plugin.features.get(MaintenanceFeature);
                    const changed = (feature as MaintenanceFeature).applyBatchModeReplace(this.fromMode, this.toMode);
                    if (changed > 0) {
                        new Notice(`Staged ${changed} plugin changes. Click "Save" in settings to apply.`);
                        this.onComplete();
                    } else {
                        new Notice(`No plugins found with mode: ${PluginModes[this.fromMode]}`);
                    }

                    btn.setButtonText("Replace all");
                    btn.buttonEl.removeClass("mod-warning");
                }),
        );
    }

    private addModeOptions(dropdown: DropdownComponent): DropdownComponent {
        Object.keys(PluginModes)
            .filter((key) => key !== "lazyOnView")
            .forEach((key) => {
                dropdown.addOption(key, PluginModes[key as PluginMode]);
            });
        return dropdown;
    }

    private buildDebugSection(container: HTMLElement) {
        new Setting(container).setName("Debug options").setHeading();
        new Setting(container)
            .setName("Debug log output")
            .setDesc("Enable detailed logs for troubleshooting.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.data.showConsoleLog).onChange((value) => {
                    this.plugin.data.showConsoleLog = value;
                    this.plugin.configureLogger();
                    void this.plugin.saveSettings();
                });
            });
    }
}
