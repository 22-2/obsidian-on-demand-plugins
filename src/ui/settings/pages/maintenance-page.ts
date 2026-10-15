import log from "loglevel";
import type { ButtonComponent } from "obsidian";
import { Notice, Setting, SettingPage } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { PLUGIN_MODE } from "src/core/types";
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import type { SyncDirection } from "src/features/maintenance/maintenance-feature";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import type OnDemandPlugin from "src/main";
import type { SettingsTab } from "src/ui/settings-tab";
import { addModeOptions } from "src/ui/settings/helpers";
import { createSettingsNotice } from "src/ui/settings/settings-notice";

const logger = log.getLogger("OnDemandPlugin/MaintenancePage");

export class MaintenancePage extends SettingPage {
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private from: PLUGIN_MODE = PLUGIN_MODE.ALWAYS_DISABLED;
    private to: PLUGIN_MODE = PLUGIN_MODE.LAZY;
    private syncDirection: SyncDirection = "lazyToCore";
    private advancedOpen = false;
    /** The last rebuild started from this page, for callers that need to wait for it. */
    rebuilding: Promise<void> = Promise.resolve();
    /** The last sync started from this page, for callers that need to wait for it. */
    syncing: Promise<void> = Promise.resolve();
    // Obsidian buttons ignore clicks only while disabled, not while their spinner shows,
    // so these flags stop a double click from starting a second run.
    private rebuildBusy = false;
    private syncBusy = false;
    constructor(plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.plugin = plugin;
        this.tab = tab;
    }
    /** Resolves once the rebuild finished, failed or was declined; failures are reported, not thrown. */
    rebuildCaches(button: ButtonComponent, feature: MaintenanceFeature): Promise<void> {
        if (this.rebuildBusy) return this.rebuilding;
        this.rebuildBusy = true;
        this.rebuilding = this.runRebuild(button, feature)
            .catch((error: unknown) => {
                logger.error("Failed to rebuild command and view caches", error);
                new Notice("Failed to rebuild command and view caches. See the console for details.");
            })
            .finally(() => {
                this.rebuildBusy = false;
            });
        return this.rebuilding;
    }
    /** Resolves once the sync finished or was refused; failures are reported, not thrown. */
    syncNow(button: ButtonComponent, feature: MaintenanceFeature): Promise<void> {
        if (this.syncBusy) return this.syncing;
        this.syncBusy = true;
        button.setDisabled(true);
        this.syncing = this.runSync(feature)
            .catch((error: unknown) => {
                logger.error("Failed to sync settings", error);
                new Notice("Failed to sync settings. See the console for details.");
            })
            .finally(() => {
                this.syncBusy = false;
                button.setDisabled(false);
            });
        return this.syncing;
    }
    hide() {
        this.tab.requestRestoreOnPageClose("maintenance");
        super.hide();
    }
    private async runSync(feature: MaintenanceFeature) {
        await this.tab.waitForImmediateSaves();
        if (this.syncDirection === "lazyToCore" && this.tab.hasPendingChanges) {
            // This direction writes Obsidian's config immediately, so
            // do not let it persist a draft that Discard could undo only
            // on the plugin-data side.
            new Notice("Save or discard pending settings before syncing to Obsidian config.");
            return;
        }
        // Writing Obsidian's config takes effect at once and may overwrite edits made outside On-Demand,
        // so show what changes first. The other direction only stages a draft that Review & save shows.
        if (this.syncDirection === "lazyToCore") {
            const preview = await feature.buildSyncPreview(this.syncDirection);
            if (preview.hasChanges) {
                const message = `${preview.label}\n${preview.summary.trimEnd()}\n\ncommunity-plugins.json is rewritten now and Obsidian restarts to apply it. Continue?`;
                if ((await showConfirmModal(this.plugin.app, { message })) !== true) return;
            }
        }
        const result = await feature.executeSync(this.syncDirection);
        new Notice(result.message);
        // Obsidian reads community-plugins.json only at startup, so restart as Apply does.
        if (this.syncDirection === "lazyToCore" && result.changed > 0) {
            this.plugin.app.commands.executeCommandById("app:reload");
            return;
        }
        if (result.changed > 0) {
            if (this.syncDirection === "coreToLazy") {
                // coreToLazy stages plugin data in memory; retain the
                // exact IDs so Save applies only the affected policies.
                result.pluginIds?.forEach((pluginId) => this.tab.pendingPluginIds.add(pluginId));
                this.tab.markDirty();
            }
            this.display();
        }
    }
    private async runRebuild(button: ButtonComponent, feature: MaintenanceFeature) {
        await this.tab.waitForImmediateSaves();
        // Rebuilding also persists settings and applies startup policies.
        if (this.tab.hasPendingChanges) {
            new Notice("Review & save or discard pending plugin changes before rebuilding caches.");
            return;
        }
        // Ask here rather than inside the rebuild so declining is not reported as a success.
        const drift = this.plugin.features.get(CommunityPluginsDriftFeature);
        if (drift && !(await drift.confirmOverwrite())) return;
        button.setDisabled(true);
        try {
            await feature.rebuildAndApplyCommandCache({ force: true, externalChangesConfirmed: true });
            new Notice("Command and view caches rebuilt successfully");
        } finally {
            button.setDisabled(false);
        }
    }
    display() {
        this.tab.offerRestoreOnPageOpen("maintenance");
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
                    // Synchronous so Obsidian's button spinner does not run while the confirmation modal waits.
                    .onClick(() => {
                        if (f) void this.rebuildCaches(b, f);
                    }),
            );
        const advanced = this.containerEl.createEl("details", { cls: "lazy-maintenance-advanced" });
        advanced.open = this.advancedOpen;
        advanced.createEl("summary", { text: "Advanced" });
        advanced.addEventListener("toggle", () => {
            this.advancedOpen = advanced.open;
        });
        const advancedContent = advanced.createDiv();
        new Setting(advancedContent).setName("Sync settings").setHeading();
        new Setting(advancedContent)
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
                    .onClick(() => {
                        if (f) void this.syncNow(b, f);
                    }),
            );
        new Setting(advancedContent).setName("Batch operations").setHeading();
        new Setting(advancedContent).setName("From mode").addDropdown((d) =>
            addModeOptions(d)
                .setValue(this.from)
                .onChange((v) => (this.from = v as PLUGIN_MODE)),
        );
        new Setting(advancedContent)
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
        createSettingsNotice(advancedContent, "lazy-batch-changes-notice", (text) => {
            text.setText("Batch changes apply only after you select save in the review dialog.");
        });
        new Setting(advancedContent).setName("Debug options").setHeading();
        new Setting(advancedContent).setName("Debug log output").addToggle((t) =>
            t.setValue(this.plugin.data.showConsoleLog).onChange(async (v) => {
                await this.tab.saveImmediateChanges((data) => {
                    data.showConsoleLog = v;
                });
                this.plugin.configureLogger();
                this.display();
            }),
        );
    }
}
