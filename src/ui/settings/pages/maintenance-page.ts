import { Notice, Setting, SettingPage } from "obsidian";
import { PLUGIN_MODE } from "src/core/types";
import type { SyncDirection } from "src/features/maintenance/maintenance-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import type OnDemandPlugin from "src/main";
import type { SettingsTab } from "src/ui/settings-tab";
import { addModeOptions } from "src/ui/settings/helpers";

export class MaintenancePage extends SettingPage {
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private from: PLUGIN_MODE = PLUGIN_MODE.ALWAYS_DISABLED;
    private to: PLUGIN_MODE = PLUGIN_MODE.LAZY;
    private syncDirection: SyncDirection = "lazyToCore";
    constructor(plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.plugin = plugin;
        this.tab = tab;
    }
    display() {
        this.containerEl.empty();
        this.containerEl.addClass("lazy-maintenance-page");
        this.tab.renderPendingControls(this.containerEl, () => this.display());
        const f = this.plugin.features.get(MaintenanceFeature);
        new Setting(this.containerEl).setName("Cache maintenance").setHeading();
        new Setting(this.containerEl)
            .setName("Rebuild command and view caches")
            .setDesc("Refresh commands and view types together for lazy plugins, then restart Obsidian.")
            .addButton((b) =>
                b
                    .setButtonText("Rebuild caches")
                    .setDestructive()
                    .onClick(async () => {
                        if (!f) return;
                        b.setDisabled(true);
                        try {
                            await f.rebuildAndApplyCommandCache({ force: true });
                            new Notice("Command and view caches rebuilt successfully");
                        } finally {
                            b.setDisabled(false);
                        }
                    }),
            );
        new Setting(this.containerEl).setName("Sync settings").setHeading();
        new Setting(this.containerEl)
            .setName("Sync direction")
            .addDropdown((d) =>
                d
                    .addOption("lazyToCore", "Plugin data -> Obsidian config")
                    .addOption("coreToLazy", "Obsidian config -> plugin data")
                    .setValue(this.syncDirection)
                    .onChange((v) => (this.syncDirection = v as SyncDirection)),
            )
            .addButton((b) =>
                b
                    .setButtonText("Sync now")
                    .setCta()
                    .onClick(async () => {
                        if (!f) return;
                        if (this.syncDirection === "lazyToCore" && this.tab.hasPendingChanges) {
                            // This direction writes Obsidian's config immediately, so
                            // do not let it persist a draft that Discard could undo only
                            // on the plugin-data side.
                            new Notice("Save or discard pending settings before syncing to Obsidian config.");
                            return;
                        }
                        const result = await f.executeSync(this.syncDirection);
                        new Notice(result.message);
                        if (result.changed > 0) {
                            if (this.syncDirection === "coreToLazy") {
                                // coreToLazy stages plugin data in memory; retain the
                                // exact IDs so Save applies only the affected policies.
                                result.pluginIds?.forEach((pluginId) => this.tab.pendingPluginIds.add(pluginId));
                                this.tab.markDirty();
                            }
                            this.display();
                        }
                    }),
            );
        new Setting(this.containerEl).setName("Batch operations").setHeading();
        new Setting(this.containerEl).setName("From mode").addDropdown((d) =>
            addModeOptions(d)
                .setValue(this.from)
                .onChange((v) => (this.from = v as PLUGIN_MODE)),
        );
        new Setting(this.containerEl)
            .setName("To mode")
            .addButton((b) =>
                b
                    .setButtonText("Replace all")
                    .setDestructive()
                    .onClick(() => {
                        if (!f || this.from === this.to) return;
                        this.plugin.updateManifests();
                        const pluginIds = this.plugin.manifests.filter((manifest) => this.plugin.getPluginMode(manifest.id) === this.from).map((manifest) => manifest.id);
                        const n = f.applyBatchModeReplace(this.from, this.to);
                        if (n) {
                            pluginIds.forEach((pluginId) => this.tab.pendingPluginIds.add(pluginId));
                            this.tab.markDirty();
                            new Notice(`Staged ${n} plugin changes. Save to apply them.`);
                            this.display();
                        }
                    }),
            )
            .addDropdown((d) =>
                addModeOptions(d)
                    .setValue(this.to)
                    .onChange((v) => (this.to = v as PLUGIN_MODE)),
            );
        new Setting(this.containerEl).setName("Debug options").setHeading();
        new Setting(this.containerEl).setName("Debug log output").addToggle((t) =>
            t.setValue(this.plugin.data.showConsoleLog).onChange(async (v) => {
                this.plugin.data.showConsoleLog = v;
                this.plugin.configureLogger();
                this.tab.markDirty();
                this.display();
            }),
        );
    }
}
