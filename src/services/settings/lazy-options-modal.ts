import { App, Modal, Notice, Setting } from "obsidian";
import OnDemandPlugin from "../../main";
import { LazyOptions } from "../../core/types";
import log from "loglevel";

const logger = log.getLogger("OnDemandPlugin/LazyOptionsModal");

export class LazyOptionsModal extends Modal {
    private options: LazyOptions;

    constructor(
        app: App,
        private plugin: OnDemandPlugin,
        private pluginId: string,
        private onSave?: () => void,
    ) {
        super(app);
        const settings = this.plugin.settings.plugins[this.pluginId];

        // Initialize options from existing settings or defaults
        this.options = settings?.lazyOptions
            ? JSON.parse(JSON.stringify(settings.lazyOptions))
            : {
                  useView: settings?.mode === "lazyOnView",
                  viewTypes: this.plugin.settings.lazyOnViews?.[pluginId] || [],
                  useFile: false,
                  fileCriteria:
                      this.plugin.settings.lazyOnFiles?.[pluginId] || {},
              };

        // Special case for Excalidraw if not configured
        if (
            pluginId === "obsidian-excalidraw-plugin" &&
            !settings?.lazyOptions
        ) {
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
        contentEl.createEl("h2", { text: `Lazy options: ${this.pluginId}` });
        contentEl.createEl("p", {
            text: "Configure advanced activation rules for this plugin.",
            cls: "setting-item-description",
        });

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
            .setDesc(
                "Load plugin when specific files are opened (by suffix, etc.).",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.options.useFile).onChange((value) => {
                    this.options.useFile = value;
                    this.onOpen();
                }),
            );

        if (this.options.useFile) {
            new Setting(contentEl)
                .setName("File Suffixes")
                .setDesc(
                    "Matches the end of the filename (basename). e.g., '.excalidraw' for 'file.excalidraw.md'",
                )
                .addTextArea((text) =>
                    text
                        .setPlaceholder(".excalidraw")
                        .setValue(
                            this.options.fileCriteria.suffixes?.join("\n") ||
                                "",
                        )
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
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Save Options")
                    .setCta()
                    .onClick(async () => {
                        const pluginSettings =
                            this.plugin.settings.plugins[this.pluginId];
                        if (pluginSettings) {
                            pluginSettings.lazyOptions = this.options;
                            // For backward compatibility during transition, also update the global maps
                            this.plugin.settings.lazyOnViews[this.pluginId] =
                                this.options.useView
                                    ? this.options.viewTypes
                                    : [];
                            this.plugin.settings.lazyOnFiles[this.pluginId] =
                                this.options.useFile
                                    ? this.options.fileCriteria
                                    : {};

                            await this.plugin.saveSettings();
                        }
                        // Notify caller (SettingsTab) so it can mark this plugin as pending
                        try {
                            this.onSave?.();
                        } catch (e) {
                            new Notice("Error in onSave callback: " + e);
                            logger.error(
                                "Error in LazyOptionsModal onSave callback",
                                e,
                            );
                        }
                        this.close();
                    }),
            );
    }
}
