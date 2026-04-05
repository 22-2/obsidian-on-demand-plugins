import log from "loglevel";
import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type { LazyOptions } from "src/core/types";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import type OnDemandPlugin from "src/main";

const logger = log.getLogger("OnDemandPlugin/LazyOptionsModal");

export class LazyOptionsModal extends Modal {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private plugin: OnDemandPlugin;
    private pluginId: string;
    private onSave?: () => void;
    private options: LazyOptions;

    constructor(
        app: App,
        plugin: OnDemandPlugin,
        pluginId: string,
        onSave?: () => void,
    ) {
        super(app);
        this.plugin = plugin;
        this.pluginId = pluginId;
        this.onSave = onSave;
        const settings = this.plugin.settings.plugins[this.pluginId];

        // Initialize options from existing settings or defaults
        this.options = settings?.lazyOptions
            ? structuredClone(settings.lazyOptions)
            : {
                  useView: settings?.mode === "lazyOnView",
                  viewTypes: this.plugin.settings.lazyOnViews?.[pluginId] || [],
                  useFile: false,
                  fileCriteria: this.plugin.settings.lazyOnFiles?.[pluginId] || {},
              };

        // Special case for Excalidraw if not configured
        if (pluginId === "obsidian-excalidraw-plugin" && !settings?.lazyOptions) {
            this.options.useFile = true;
            this.options.fileCriteria = {
                suffixes: [".excalidraw"],
                frontmatterKeys: ["excalidraw-plugin"],
            };
        }
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
            .setDesc("Force reload command cache for this plugin only.")
            .addButton((btn) =>
                btn
                    .setButtonText("Reload this plugin cache")
                    .setWarning()
                    .onClick(() => {
                        void (async () => {
                            btn.setDisabled(true);
                            try {
                                const lazyEngine = this.plugin.features.get(LazyEngineFeature);
                                if (!lazyEngine) {
                                    new Notice("Lazy engine is not available");
                                    return;
                                }

                                await lazyEngine.commandCache.forceReloadPluginCache(this.pluginId);
                                new Notice(`Reloaded command cache for ${this.pluginId}`);
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
                    text
                        .setValue(this.options.fileCriteria.suffixes?.join("\n") || "")
                        .onChange((value) => {
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
                        const pluginSettings = this.plugin.settings.plugins[this.pluginId];
                        if (pluginSettings) {
                            pluginSettings.lazyOptions = this.options;
                            // For backward compatibility during transition, also update the global maps
                            this.plugin.settings.lazyOnViews[this.pluginId] = this.options.useView ? this.options.viewTypes : [];
                            this.plugin.settings.lazyOnFiles[this.pluginId] = this.options.useFile ? this.options.fileCriteria : {};
                        }
                        // Notify caller (SettingsTab) so it can mark this plugin as pending
                        try {
                            this.onSave?.();
                        } catch (e) {
                            new Notice("Error in onSave callback: " + e);
                            logger.error("Error in LazyOptionsModal onSave callback", e);
                        }
                        this.close();
                    }),
            );
    }
}
