import { App, Modal, Setting, TextComponent, ButtonComponent, Notice } from "obsidian";
import type { SettingsService } from "./settings-service";
import { showConfirmModal } from "src/core/showConfirmModal";

export class ProfileManagerModal extends Modal {
    constructor(
        app: App,
        private settingsService: SettingsService,
        private onProfileChanged: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Manage Profiles" });

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
            if (isDesktopDefault) tags.push("Desktop Default");
            if (isMobileDefault) tags.push("Mobile Default");
            
            if (tags.length > 0) {
                metaEl.textContent = tags.join(" • ");
            }

            // Actions
            const actionsDiv = row.createEl("div", { cls: "lazy-profile-actions" });

            // Rename
            new ButtonComponent(actionsDiv)
                .setIcon("pencil")
                .setTooltip("Rename")
                .onClick(() => {
                    this.openRenameModal(id, profile.name);
                });

            // Duplicate
            new ButtonComponent(actionsDiv)
                .setIcon("copy")
                .setTooltip("Duplicate")
                .onClick(async () => {
                    this.settingsService.createProfile(`${profile.name} (Copy)`, id);
                    await this.settingsService.save();
                    this.onProfileChanged();
                    this.onOpen(); // Refresh
                });

            // Defaults Settings (Only if not already default)
            if (!isDesktopDefault) {
                new ButtonComponent(actionsDiv)
                    .setIcon("monitor")
                    .setTooltip("Set as Desktop Default")
                    .onClick(async () => {
                        this.settingsService.setDeviceDefault(id, "desktop");
                        await this.settingsService.save();
                        this.onOpen();
                    });
            }

            if (!isMobileDefault) {
               new ButtonComponent(actionsDiv)
                    .setIcon("smartphone")
                    .setTooltip("Set as Mobile Default")
                    .onClick(async () => {
                        this.settingsService.setDeviceDefault(id, "mobile");
                        await this.settingsService.save();
                        this.onOpen();
                    });
            }

            // Delete
            if (profileIds.length > 1 && !isCurrent) {
                new ButtonComponent(actionsDiv)
                    .setIcon("trash")
                    .setTooltip("Delete")
                    .setWarning()
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
                    });
            }
        });

        // Add new Profile
        new Setting(contentEl)
            .setName("Create New Profile")
            .addButton((btn) => {
                btn.setButtonText("Create")
                   .setCta()
                   .onClick(() => {
                       this.openCreateModal();
                   })
            });
    }

    openRenameModal(id: string, currentName: string) {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Rename Profile");
        
        let newName = currentName;
        
        new Setting(modal.contentEl)
            .setName("Name")
            .addText(text => text.setValue(currentName).onChange(v => newName = v));
            
        new Setting(modal.contentEl)
            .addButton(btn => btn
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
                }));
                
        modal.open();
    }

    openCreateModal() {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Create Profile");
        
        let newName = "";
        
        new Setting(modal.contentEl)
            .setName("Profile Name")
            .addText(text => text.setPlaceholder("My new profile").onChange(v => newName = v));
            
        new Setting(modal.contentEl)
            .addButton(btn => btn
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
                }));
                
        modal.open();
    }
}
