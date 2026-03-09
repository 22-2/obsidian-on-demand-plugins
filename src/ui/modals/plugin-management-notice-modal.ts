import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type { PluginContext } from "../../core/plugin-context";

export class PluginManagementNoticeModal extends Modal {
    constructor(
        app: App,
        private ctx: PluginContext,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;

        new Setting(contentEl).setName("⚠️ Always use On-Demand Plugins for management").setHeading();
        contentEl.createEl("p", {
            text: "This plugin manages other plugins' load states. Changing plugin states (enable/disable) in the standard Obsidian menu may cause unexpected behavior or lose your lazy-loading settings.",
        });

        new Setting(contentEl)
            .setName("Don't show this again")
            .setDesc("Checking this will suppress this warning in the future.")
            .addToggle((toggle) =>
                toggle.setValue(this.ctx.getData().suppressPluginManagementNotice).onChange(async (value) => {
                    this.ctx.getData().suppressPluginManagementNotice = value;
                    await this.ctx.saveSettings();
                }),
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("Go to On-Demand Plugins setting")
                    .setCta()
                    .onClick(() => {
                        (this.app as any).setting.open();
                        (this.app as any).setting.openTabById(this.ctx._plugin.manifest.id);
                        this.close();
                    }),
            )
            .addButton((btn) =>
                btn.setButtonText("Proceed anyway").onClick(() => {
                    this.close();
                }),
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
