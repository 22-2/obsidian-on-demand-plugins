import type { App } from "obsidian";
import { ExtraButtonComponent, Menu, Modal, Notice, Setting } from "obsidian";
import { showConfirmModal } from "src/core/showConfirmModal";
import type { SettingsService } from "./settings-service";

export class ProfileManagerModal extends Modal {
    constructor(
        app: App,
        private settingsService: SettingsService,
        private onProfileChanged: () => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Manage profiles" });

        const profiles = this.settingsService.data.profiles;
        const profileIds = Object.keys(profiles);

        // List existing profiles
        const listContainer = contentEl.createEl("div", { cls: "lazy-profile-list" });

        profileIds.forEach((id) => {
            const profile = profiles[id];
            const isCurrent = id === this.settingsService.currentProfileId;
            const isDesktopDefault = id === this.settingsService.data.desktopProfileId;
            const isMobileDefault = id === this.settingsService.data.mobileProfileId;

            const row = listContainer.createEl("div", { cls: "lazy-profile-row" });

            // Profile Name & Status
            const infoDiv = row.createEl("div", { cls: "lazy-profile-info" });

            infoDiv.createEl("div", { cls: "lazy-profile-name", text: profile.name });

            const metaEl = infoDiv.createEl("div", { cls: "lazy-profile-meta", text: "" });

            const tags = [];
            if (isCurrent) tags.push("Active");
            if (isDesktopDefault) tags.push("Desktop default");
            if (isMobileDefault) tags.push("Mobile default");

            if (tags.length > 0) {
                metaEl.textContent = tags.join(" • ");
            }

            // Actions
            const actionsDiv = row.createEl("div", { cls: "lazy-profile-actions" });

            const btn = new ExtraButtonComponent(actionsDiv).setIcon("ellipsis-vertical").setTooltip("More options");

            btn.extraSettingsEl.onClickEvent((evt: MouseEvent) => {
                const menu = new Menu();

                menu.addItem((item) =>
                    item
                        .setTitle("Rename")
                        .setIcon("pencil")
                        .onClick(() => this.openRenameModal(id, profile.name)),
                );

                menu.addItem((item) =>
                    item
                        .setTitle("Duplicate")
                        .setIcon("copy")
                        .onClick(async () => {
                            this.settingsService.createProfile(`${profile.name} (Copy)`, id);
                            await this.settingsService.save();
                            this.onProfileChanged();
                            this.onOpen();
                        }),
                );

                menu.addSeparator();

                menu.addItem((item) =>
                    item
                        .setTitle("Set as Desktop default")
                        .setIcon("monitor")
                        .setChecked(isDesktopDefault)
                        .setDisabled(isDesktopDefault)
                        .onClick(async () => {
                            this.settingsService.setDeviceDefault(id, "desktop");
                            await this.settingsService.save();
                            this.onOpen();
                        }),
                );

                menu.addItem((item) =>
                    item
                        .setTitle("Set as Mobile default")
                        .setIcon("smartphone")
                        .setChecked(isMobileDefault)
                        .setDisabled(isMobileDefault)
                        .onClick(async () => {
                            this.settingsService.setDeviceDefault(id, "mobile");
                            await this.settingsService.save();
                            this.onOpen();
                        }),
                );

                if (profileIds.length > 1 && !isCurrent) {
                    menu.addSeparator();
                    menu.addItem((item) =>
                        item
                            .setTitle("Delete")
                            .setIcon("trash")
                            .onClick(async () => {
                                if (isDesktopDefault || isMobileDefault) {
                                    new Notice("Cannot delete a default profile. Assign another default first.");
                                    return;
                                }
                                if (await showConfirmModal(this.app, { message: `Are you sure you want to delete profile "${profile.name}"?` })) {
                                    this.settingsService.deleteProfile(id);
                                    await this.settingsService.save();
                                    this.onProfileChanged();
                                    this.onOpen();
                                }
                            }),
                    );
                }

                menu.showAtMouseEvent(evt);
            });
        });

        // Add new Profile
        new Setting(contentEl).setName("Create new profile").addButton((btn) => {
            btn.setButtonText("Create")
                .setCta()
                .onClick(() => {
                    this.openCreateModal();
                });
        });
    }

    openRenameModal(id: string, currentName: string) {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Rename profile");

        let newName = currentName;

        new Setting(modal.contentEl).setName("Name").addText((text) => text.setValue(currentName).onChange((v) => (newName = v)));

        new Setting(modal.contentEl).addButton((btn) =>
            btn
                .setButtonText("Save")
                .setCta()
                .onClick(async () => {
                    if (newName) {
                        this.settingsService.renameProfile(id, newName);
                        await this.settingsService.save();
                        this.onProfileChanged();
                        this.onOpen();
                        modal.close();
                    }
                }),
        );

        modal.open();
    }

    openCreateModal() {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Create profile");

        let newName = "";

        new Setting(modal.contentEl).setName("Profile name").addText((text) => text.setPlaceholder("My new profile").onChange((v) => (newName = v)));

        new Setting(modal.contentEl).addButton((btn) =>
            btn
                .setButtonText("Create")
                .setCta()
                .onClick(async () => {
                    if (newName) {
                        this.settingsService.createProfile(newName); // Creates from default blank-ish
                        await this.settingsService.save();
                        this.onProfileChanged();
                        this.onOpen();
                        modal.close();
                    }
                }),
        );

        modal.open();
    }
}
