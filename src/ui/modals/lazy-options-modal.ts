import log from "loglevel";
import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type { LazyOptions } from "src/core/types";
import type { SettingsUiHost } from "src/ui/settings-ui-host";
import { currentLazyOptions, stageLazyOptions } from "src/ui/settings/helpers";

const logger = log.getLogger("OnDemandPlugin/LazyOptionsModal");

export class LazyOptionsModal extends Modal {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private plugin: SettingsUiHost;
    private pluginId: string;
    private onSave?: () => void;
    private options: LazyOptions;
    private initialOptionsSnapshot: string;

    constructor(app: App, plugin: SettingsUiHost, pluginId: string, onSave?: () => void) {
        super(app);
        this.plugin = plugin;
        this.pluginId = pluginId;
        this.onSave = onSave;
        // Shared with the plugin table, which toggles the same options inline.
        this.options = currentLazyOptions(this.plugin, pluginId);

        this.initialOptionsSnapshot = JSON.stringify(this.options);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName(`Lazy options for ${this.pluginId}`).setHeading();
        contentEl.createEl("p", {
            text: "Configure advanced activation rules for this plugin. Plugins also load automatically when their commands run.",
            cls: "setting-item-description",
        });

        new Setting(contentEl)
            .setName("Cache")
            .setDesc("Force rebuild the command and view caches for this plugin only. A running plugin is briefly reloaded to capture its views.")
            .addButton((btn) =>
                btn
                    .setButtonText("Reload this plugin cache")
                    .setDestructive()
                    .onClick(() => {
                        void (async () => {
                            btn.setDisabled(true);
                            try {
                                if (!(await this.plugin.rebuildPluginCaches(this.pluginId))) {
                                    new Notice("Startup policy is not available");
                                    return;
                                }
                                new Notice(`Reloaded command and view caches for ${this.pluginId}`);
                            } catch (error: unknown) {
                                const message = error instanceof Error ? error.message : String(error);
                                new Notice(`Failed to reload cache for ${this.pluginId}`);
                                logger.error("Failed to force reload plugin cache", this.pluginId, message);
                            } finally {
                                btn.setDisabled(false);
                            }
                        })();
                    }),
            );

        // --- View Settings ---
        new Setting(contentEl)
            .setName("Lazy on view")
            .setDesc("Load plugin when specific view types are opened.")
            .addToggle((toggle) =>
                toggle.setValue(this.options.useView).onChange((value) => {
                    this.options.useView = value;
                    this.onOpen();
                }),
            );

        // if (this.options.useView) {
        //     new Setting(contentEl)
        //         .setName("View Types")
        //         .setDesc("View type IDs (e.g., 'markdown', 'lineage', 'excalidraw'). Separate by commas or newlines.")
        //         .addTextArea(text => text
        //             .setPlaceholder("markdown, lineage")
        //             .setValue(this.options.viewTypes.join("\n"))
        //             .onChange(value => {
        //                 this.options.viewTypes = value.split(/[\n,]/).map(s => s.trim()).filter(s => s !== "");
        //             })
        //         );
        // }

        // --- File Settings ---
        new Setting(contentEl)
            .setName("Lazy on file")
            .setDesc("Load plugin when specific files are opened (by suffix, etc.).")
            .addToggle((toggle) =>
                toggle.setValue(this.options.useFile).onChange((value) => {
                    this.options.useFile = value;
                    this.onOpen();
                }),
            );

        if (this.options.useFile) {
            new Setting(contentEl)
                .setName("File suffixes")
                .setDesc("Match the end of the file name, one suffix per line.")
                .addTextArea((text) =>
                    text.setValue(this.options.fileCriteria.suffixes?.join("\n") || "").onChange((value) => {
                        this.options.fileCriteria.suffixes = value
                            .split(/[\n,]/)
                            .map((s) => s.trim())
                            .filter((s) => s !== "");
                    }),
                );

            // new Setting(contentEl)
            //     .setName("Frontmatter Keys")
            //     .setDesc("Key names that must exist in the file's YAML frontmatter.")
            //     .addTextArea(text => text
            //         .setPlaceholder("lineage-view")
            //         .setValue(this.options.fileCriteria.frontmatterKeys?.join("\n") || "")
            //         .onChange(value => {
            //             this.options.fileCriteria.frontmatterKeys = value.split(/[\n,]/).map(s => s.trim()).filter(s => s !== "");
            //         })
            //     );

            // new Setting(contentEl)
            //     .setName("Content Patterns (Regex)")
            //     .setDesc("Regular expressions to match against the file's text content.")
            //     .addTextArea(text => text
            //         .setPlaceholder("\\*\\*Lineage\\*\\*")
            //         .setValue(this.options.fileCriteria.contentPatterns?.join("\n") || "")
            //         .onChange(value => {
            //             this.options.fileCriteria.contentPatterns = value.split("\n").map(s => s.trim()).filter(s => s !== "");
            //         })
            //     );
        }

        // --- Buttons ---
        const buttonContainer = contentEl.createDiv({
            cls: "modal-button-container",
        });

        new Setting(buttonContainer)
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
            .addButton((btn) =>
                btn
                    .setButtonText("Save")
                    .setCta()
                    .onClick(() => {
                        const hasChanges = JSON.stringify(this.options) !== this.initialOptionsSnapshot && stageLazyOptions(this.plugin, this.pluginId, this.options);
                        // Notify caller (SettingsTab) so it can mark this plugin as pending
                        if (hasChanges) {
                            try {
                                this.onSave?.();
                            } catch (e) {
                                new Notice("Error in onSave callback: " + (String(e) || "Unknown error"));
                                logger.error("Error in LazyOptionsModal onSave callback", e);
                            }
                        }
                        this.close();
                    }),
            );
    }
}
