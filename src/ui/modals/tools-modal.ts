import { App, DropdownComponent, Modal, Notice, Setting, setIcon } from "obsidian";
import { PLUGIN_MODE, PluginMode, PluginModes } from "../../core/types";
import type OnDemandPlugin from "../../main";
import type { SyncDirection, SyncPreviewResult, SyncResult } from "../../services/maintenance/maintenance-service";

export class ToolsModal extends Modal {
    private fromMode: PluginMode = PLUGIN_MODE.ALWAYS_DISABLED;
    private toMode: PluginMode = PLUGIN_MODE.LAZY;
    private confirmTimeout: number | null = null;

    constructor(
        app: App,
        private plugin: OnDemandPlugin,
        private onComplete: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setName("Tools").setHeading();
        contentEl.setAttr("class", "lazy-tools-modal");

        this.buildSyncSettingsSection(contentEl);
        this.buildRebuildCacheSection(contentEl);
        this.buildBatchReplaceModeSection(contentEl);

        new Setting(contentEl).addButton((btn) =>
            btn.setButtonText("Replace all").setClass("replace-button").onClick(async () => {
                if (this.fromMode === this.toMode) {
                    new Notice("Source and target modes are the same");
                    return;
                }

                if (btn.buttonEl.innerText === "Replace all") {
                    btn.setButtonText("Click to confirm").setWarning();
                    if (this.confirmTimeout) window.clearTimeout(this.confirmTimeout);
                    this.confirmTimeout = window.setTimeout(() => {
                        btn.setButtonText("Replace all");
                        btn.buttonEl.removeClass("mod-warning");
                    }, 3000);
                    return;
                }

                if (this.confirmTimeout) {
                    window.clearTimeout(this.confirmTimeout);
                    this.confirmTimeout = null;
                }

                const changed = this.plugin.container.maintenance.applyBatchModeReplace(
                    this.fromMode,
                    this.toMode
                );
                if (changed > 0) {
                    await this.plugin.saveSettings();
                    new Notice(
                        `Updated ${changed} plugins from ${
                            PluginModes[this.fromMode]
                        } to ${PluginModes[this.toMode]}`
                    );
                    this.onComplete();
                } else {
                    new Notice(
                        `No plugins found with mode: ${
                            PluginModes[this.fromMode]
                        }`
                    );
                }

                btn.setButtonText("Replace all");
                btn.buttonEl.removeClass("mod-warning");
            })
        );

        const closeButtonContainer = contentEl.createDiv({
            cls: "modal-button-container",
        });

        new Setting(closeButtonContainer).addButton((btn) =>
            btn.setButtonText("Close").onClick(() => this.close())
        );
    }

    onClose() {
        this.contentEl.empty();
    }

    // -------------------------------------------------------------------------
    // Section builders
    // -------------------------------------------------------------------------

    private buildSyncSettingsSection(container: HTMLElement) {
        new Setting(container).setName("Sync options").setHeading();

        const calloutEl = container.createDiv({ cls: ["callout", "lazy-sync"], attr: { "data-callout": "info" } });
        
        const calloutTitle = calloutEl.createDiv({ cls: "callout-title" });
        const calloutIcon = calloutTitle.createDiv({ cls: "callout-icon" });
        setIcon(calloutIcon, "info");
        
        const previewEl = calloutTitle.createDiv({ cls: "callout-title-inner" });
        const calloutContent = calloutEl.createDiv({ cls: "callout-content" });
        const summaryEl = calloutContent.createDiv({ cls: "lazy-sync-summary" });

        const syncContainer = container.createDiv("lazy-sync-container");

        let syncDirection: SyncDirection = "coreToLazy";

        const refreshPreview = async () => {
            const result = await this.plugin.container.maintenance.buildSyncPreview(syncDirection);
            previewEl.setText(result.label);
            summaryEl.setText(result.summary);
        };

        refreshPreview();

        new Setting(syncContainer)
            .setName("Sync direction")
            .setDesc("Choose which source should update the other.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("coreToLazy", "Obsidian config ➔ Plugin data")
                    .addOption("lazyToCore", "Plugin data ➔ Obsidian config")
                    .setValue(syncDirection)
                    .onChange((val: SyncDirection) => {
                        syncDirection = val;
                        refreshPreview();
                    });
            });

        new Setting(syncContainer).addButton((btn) =>
            btn
                .setButtonText("Sync now")
                .setClass("sync-button")
                .setCta()
                .onClick(async () => {
                    const result = await this.plugin.container.maintenance.executeSync(syncDirection);
                    new Notice(result.message);
                    if (result.changed > 0) this.onComplete();
                    await refreshPreview();
                })
        );
    }

    private buildRebuildCacheSection(container: HTMLElement) {
        new Setting(container).setName("Maintenance").setHeading();
        new Setting(container)
            .setName("Force rebuild command cache")
            .setDesc("Force a rebuild of the cached commands for lazy plugins.")
            .addButton((btn) =>
                btn
                    .setButtonText("Rebuild cache")
                    .setWarning()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        try {
                            await this.plugin.rebuildAndApplyCommandCache({
                                force: true,
                            });
                            new Notice("Command cache rebuilt successfully");
                        } catch {
                            new Notice("Failed to rebuild command cache");
                        } finally {
                            btn.setDisabled(false);
                        }
                    })
            );
    }

    private buildBatchReplaceModeSection(container: HTMLElement) {
        new Setting(container).setName("Batch replace").setHeading();
        const batchContainer = container.createDiv(
            "lazy-batch-replace-container"
        );

        new Setting(batchContainer)
            .setName("From mode")
            .addDropdown((dd) =>
                this.addModeOptions(dd)
                    .setValue(this.fromMode)
                    .onChange((val: PluginMode) => {
                        this.fromMode = val;
                    })
            );

        new Setting(batchContainer)
            .setName("To mode")
            .addDropdown((dd) =>
                this.addModeOptions(dd)
                    .setValue(this.toMode)
                    .onChange((val: PluginMode) => {
                        this.toMode = val;
                    })
            );
    }

    private addModeOptions(dropdown: DropdownComponent): DropdownComponent {
        Object.keys(PluginModes)
            .filter((key) => key !== "lazyOnView")
            .forEach((key) =>
                dropdown.addOption(key, PluginModes[key as PluginMode])
            );
        return dropdown;
    }
}

