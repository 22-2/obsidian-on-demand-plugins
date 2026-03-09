import { App, Modal, Setting, Notice, DropdownComponent } from "obsidian";
import type OnDemandPlugin from "../../main";
import { PluginMode, PluginModes, PLUGIN_MODE } from "../../core/types";

type SyncDirection = "coreToLazy" | "lazyToCore";

interface SyncPreviewResult {
    label: string;
    summary: string;
}

interface SyncResult {
    changed: number;
    message: string;
}

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
            const result = await this.buildSyncPreview(syncDirection);
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
                    const result = await this.executeSync(syncDirection);
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
                const changed = this.applyBatchModeReplace(fromMode, toMode);
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

    // -------------------------------------------------------------------------
    // Sync logic
    // -------------------------------------------------------------------------

    private async buildSyncPreview(
        direction: SyncDirection
    ): Promise<SyncPreviewResult> {
        await this.plugin.container.registry.loadEnabledPluginsFromDisk(
            this.plugin.data.showConsoleLog
        );
        const onDisk = this.plugin.container.registry.enabledPluginsFromDisk;
        const manifests = this.plugin.manifests;

        if (direction === "coreToLazy") {
            const toEnable = manifests.filter(
                (m) =>
                    onDisk.has(m.id) &&
                    this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_DISABLED
            );
            const toDisable = manifests.filter(
                (m) =>
                    !onDisk.has(m.id) &&
                    this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED
            );

            return {
                label: "📂 community-plugins.json ➔ ⚙️ On-Demand Plugins",
                summary: this.buildDiffSummary(
                    `Enabled on disk: ${onDisk.size} plugins`,
                    toEnable.map((m) => m.name),
                    toDisable.map((m) => m.name)
                ),
            };
        } else {
            const alwaysEnabled = this.getAlwaysEnabledIds();
            const toAdd = alwaysEnabled.filter((id) => !onDisk.has(id));
            const toRemove = Array.from(onDisk).filter(
                (id) =>
                    !alwaysEnabled.includes(id) &&
                    manifests.some((m) => m.id === id)
            );

            return {
                label: "⚙️ On-Demand Plugins ➔ 📂 community-plugins.json",
                summary: this.buildDiffSummary(
                    `Always Enabled in On-Demand: ${alwaysEnabled.length} plugins`,
                    toAdd,
                    toRemove
                ),
            };
        }
    }

    private async executeSync(direction: SyncDirection): Promise<SyncResult> {
        await this.plugin.container.registry.loadEnabledPluginsFromDisk(
            this.plugin.data.showConsoleLog
        );

        if (direction === "coreToLazy") {
            return this.syncCoreToLazy();
        } else {
            return this.syncLazyToCore();
        }
    }

    private syncCoreToLazy(): SyncResult {
        const onDisk = this.plugin.container.registry.enabledPluginsFromDisk;
        let changed = 0;

        for (const manifest of this.plugin.manifests) {
            const isOnDisk = onDisk.has(manifest.id);
            const currentMode = this.plugin.getPluginMode(manifest.id);

            const targetMode: PluginMode | null =
                isOnDisk && currentMode === PLUGIN_MODE.ALWAYS_DISABLED
                    ? PLUGIN_MODE.ALWAYS_ENABLED
                    : !isOnDisk && currentMode === PLUGIN_MODE.ALWAYS_ENABLED
                    ? PLUGIN_MODE.ALWAYS_DISABLED
                    : null;

            if (targetMode) {
                this.plugin.settings.plugins[manifest.id] = {
                    mode: targetMode,
                    userConfigured: true,
                };
                changed++;
            }
        }

        if (changed > 0) {
            this.plugin.saveSettings();
            return { changed, message: `Synced ${changed} plugins TO On-Demand Plugins` };
        }
        return { changed: 0, message: "On-Demand Plugins is already in sync with Obsidian config" };
    }

    private async syncLazyToCore(): Promise<SyncResult> {
        const alwaysEnabled = this.getAlwaysEnabledIds();
        const currentOnDisk = Array.from(
            this.plugin.container.registry.enabledPluginsFromDisk
        );
        const isSame =
            alwaysEnabled.length === currentOnDisk.length &&
            alwaysEnabled.every((id) => currentOnDisk.includes(id));

        if (!isSame) {
            await this.plugin.container.registry.writeCommunityPluginsFile(
                alwaysEnabled,
                this.plugin.data.showConsoleLog
            );
            await this.plugin.container.registry.loadEnabledPluginsFromDisk(
                this.plugin.data.showConsoleLog
            );
            return {
                changed: 1,
                message: "Updated community-plugins.json based on Plugin data",
            };
        }
        return {
            changed: 0,
            message: "Obsidian config is already in sync with Plugin data",
        };
    }

    // -------------------------------------------------------------------------
    // Batch replace logic
    // -------------------------------------------------------------------------

    private applyBatchModeReplace(fromMode: PluginMode, toMode: PluginMode): number {
        let changed = 0;
        for (const manifest of this.plugin.manifests) {
            if (this.plugin.getPluginMode(manifest.id) === fromMode) {
                this.plugin.settings.plugins[manifest.id] = {
                    mode: toMode,
                    userConfigured: true,
                };
                changed++;
            }
        }
        return changed;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private getAlwaysEnabledIds(): string[] {
        const ids = this.plugin.manifests
            .filter((m) => this.plugin.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED)
            .map((m) => m.id);

        if (!ids.includes(this.plugin.manifest.id)) {
            ids.push(this.plugin.manifest.id);
        }
        return ids;
    }

    private buildDiffSummary(
        header: string,
        toAdd: string[],
        toRemove: string[]
    ): string {
        const preview = (items: string[]) =>
            `${items.slice(0, 3).join(", ")}${items.length > 3 ? "..." : ""}`;

        let summary = `${header}\n`;
        if (toAdd.length > 0)
            summary += `➕ Will enable: ${toAdd.length} (${preview(toAdd)})\n`;
        if (toRemove.length > 0)
            summary += `➖ Will disable: ${toRemove.length} (${preview(toRemove)})\n`;
        if (toAdd.length === 0 && toRemove.length === 0)
            summary += "✅ Already in sync";

        return summary;
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
