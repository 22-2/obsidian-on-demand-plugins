import { App, DropdownComponent, Modal, Notice, Setting } from "obsidian";
import { PLUGIN_MODE, PluginMode, PluginModes } from "../../core/types";
import type OnDemandPlugin from "../../main";
import type { SyncDirection, SyncPreviewResult, SyncResult } from "../../services/maintenance/maintenance-service";

export class ToolsModal extends Modal {
    constructor(
        app: App,
        private plugin: OnDemandPlugin,
        private onComplete: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Tools" });

        this.buildSyncSettingsSection(contentEl);
        this.buildRebuildCacheSection(contentEl);
        this.buildBatchReplaceModeSection(contentEl);
    }

    onClose() {
        this.contentEl.empty();
    }

    // -------------------------------------------------------------------------
    // Section builders
    // -------------------------------------------------------------------------

    private buildSyncSettingsSection(container: HTMLElement) {
        container.createEl("h3", { text: "Sync settings" });
        const syncContainer = container.createDiv("lazy-sync-container");

        let syncDirection: SyncDirection = "coreToLazy";

        const previewEl = syncContainer.createEl("div", {
            cls: "lazy-sync-preview",
        });
        const summaryEl = syncContainer.createEl("div", {
            cls: "lazy-sync-summary",
        });

        const refreshPreview = async () => {
            const result = await this.plugin.container.maintenance.buildSyncPreview(syncDirection);
            previewEl.setText(result.label);
            summaryEl.setText(result.summary);
            summaryEl.style.whiteSpace = "pre-wrap";
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
        container.createEl("h3", { text: "Batch replace modes" });
        const batchContainer = container.createDiv(
            "lazy-batch-replace-container"
        );

        let fromMode: PluginMode = PLUGIN_MODE.ALWAYS_DISABLED;
        let toMode: PluginMode = PLUGIN_MODE.LAZY;

        new Setting(batchContainer)
            .setName("From mode")
            .addDropdown((dd) =>
                this.addModeOptions(dd).setValue(fromMode).onChange((val: PluginMode) => {
                    fromMode = val;
                })
            );

        new Setting(batchContainer)
            .setName("To mode")
            .addDropdown((dd) =>
                this.addModeOptions(dd).setValue(toMode).onChange((val: PluginMode) => {
                    toMode = val;
                })
            );

        new Setting(batchContainer).addButton((btn) =>
            btn.setButtonText("Replace all").onClick(async () => {
                if (fromMode === toMode) {
                    new Notice("Source and target modes are the same");
                    return;
                }
                const changed = this.plugin.container.maintenance.applyBatchModeReplace(fromMode, toMode);
                if (changed > 0) {
                    await this.plugin.saveSettings();
                    new Notice(
                        `Updated ${changed} plugins from ${PluginModes[fromMode]} to ${PluginModes[toMode]}`
                    );
                    this.onComplete();
                } else {
                    new Notice(
                        `No plugins found with mode: ${PluginModes[fromMode]}`
                    );
                }
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

