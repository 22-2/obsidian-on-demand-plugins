/* eslint-disable @typescript-eslint/no-misused-promises, no-useless-escape -- Obsidian's void handlers bridge async profile persistence. */
import type { App, ButtonComponent } from "obsidian";
import { ExtraButtonComponent, Menu, Modal, Notice, Setting, SettingPage } from "obsidian";
import type { DeviceType } from "src/core/types";
import { showConfirmModal } from "src/core/confirm-modal";
import type { SettingsTab } from "src/ui/settings-tab";
import type { SettingsUiHost } from "src/ui/settings-ui-host";
import { openBackupDirectory } from "src/ui/settings/helpers";
import { createSettingsNotice } from "src/ui/settings/settings-notice";

export class ProfileManagementPage extends SettingPage {
    private app: App;
    private plugin: SettingsUiHost;
    private tab: SettingsTab;
    private createName = "";

    constructor(app: App, plugin: SettingsUiHost, tab: SettingsTab) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.tab = tab;
    }

    display() {
        this.containerEl.empty();
        this.containerEl.addClass("lazy-profile-page");
        const syncNotice = createSettingsNotice(this.containerEl, "lazy-profile-sync-notice", (text) => {
            // Profiles share data.json, so full-file saves can conflict across devices; this reminder asks users to coordinate edits without automatically applying synced profiles.
            text.appendText("If you sync this plugin's settings across devices: ");
            text.createEl("strong", { text: "Edit settings on one device only." });
            text.appendText(" After changing these settings on another device: ");
            text.createEl("strong", { text: "Wait for sync to finish, then reload this plugin on this device." });
            text.appendText(" ");
            text.createEl("strong", { text: "Concurrent edits or editing on another device while offline" });
            text.appendText(" may cause conflicts or overwrite changes.");
        });
        this.containerEl.prepend(syncNotice);
        const profileIds = Object.keys(this.plugin.data.profiles);

        new Setting(this.containerEl)
            .setName("Profiles")
            .setHeading()
            .setDesc("Choose which profile is active. Device defaults are managed separately below.")
            .addExtraButton((button) =>
                button
                    .setIcon("folder-open")
                    .setTooltip("Open backup folder")
                    .onClick(() => void openBackupDirectory(this.plugin)),
            );

        const list = this.containerEl.createDiv({ cls: "lazy-profile-list" });
        profileIds.forEach((id) => this.renderProfileCard(list, id));

        new Setting(this.containerEl).setName("Create profile").setHeading();
        let createButton: ButtonComponent | undefined;
        new Setting(this.containerEl)
            .setName("Profile name")
            .setDesc("New profiles start with the default settings.")
            .addText((text) =>
                text
                    .setPlaceholder("E.g. Writing")
                    .setValue(this.createName)
                    .onChange((value) => {
                        this.createName = value;
                        createButton?.setDisabled(!value.trim());
                    }),
            )
            .addButton((button) => {
                createButton = button;
                button
                    .setButtonText("Create")
                    .setCta()
                    .setDisabled(!this.createName.trim())
                    .onClick(() => void this.createProfile());
            });

        new Setting(this.containerEl).setName("Device defaults").setHeading().setDesc("Choose the profile loaded by default on each device type.");
        this.renderDeviceDefault("Desktop", "desktop", this.plugin.data.desktopProfileId);
        this.renderDeviceDefault("Mobile", "mobile", this.plugin.data.mobileProfileId);
    }

    private renderProfileCard(list: HTMLElement, id: string) {
        const profile = this.plugin.data.profiles[id];
        const isCurrent = id === this.plugin.currentProfileId;
        const isDesktopDefault = id === this.plugin.data.desktopProfileId;
        const isMobileDefault = id === this.plugin.data.mobileProfileId;
        const row = list.createDiv({ cls: ["lazy-profile-card", isCurrent ? "is-current" : ""] });
        row.setAttr("role", "group");

        const info = row.createDiv({ cls: "lazy-profile-info" });
        info.createDiv({ cls: "lazy-profile-name", text: profile.name });
        const badges = info.createDiv({ cls: "lazy-profile-badges" });
        if (isCurrent) badges.createSpan({ cls: "lazy-profile-badge is-active", text: "Active" });
        if (isDesktopDefault) badges.createSpan({ cls: "lazy-profile-badge", text: "Desktop default" });
        if (isMobileDefault) badges.createSpan({ cls: "lazy-profile-badge", text: "Mobile default" });
        if (id === "initial-backup") badges.createSpan({ cls: "lazy-profile-badge", text: "Initial backup" });

        const actions = row.createDiv({ cls: "lazy-profile-actions" });
        if (isCurrent) {
            actions.createSpan({ cls: "lazy-profile-current-label", text: "Current profile" });
        }
        new ExtraButtonComponent(actions)
            .setIcon("ellipsis-vertical")
            .setTooltip("Profile actions")
            .onClick(() => {
                const menu = new Menu();
                if (!isCurrent) {
                    menu.addItem((item) =>
                        item
                            .setTitle("Use this profile")
                            .setIcon("check")
                            .onClick(() => void this.switchProfile(id)),
                    );
                    menu.addSeparator();
                }
                menu.addItem((item) =>
                    item
                        .setTitle("Rename")
                        .setIcon("pencil")
                        .onClick(() => this.openNameModal(id, profile.name)),
                );
                menu.addItem((item) =>
                    item
                        .setTitle("Duplicate")
                        .setIcon("copy")
                        .onClick(async () => {
                            await this.tab.createProfile(`${profile.name} (Copy)`, id);
                            this.display();
                        }),
                );
                menu.addSeparator();
                menu.addItem((item) =>
                    item
                        .setTitle("Open backup folder")
                        .setIcon("folder-open")
                        .onClick(() => void openBackupDirectory(this.plugin)),
                );
                if (profileIdsFor(this.plugin).length > 1 && !isCurrent) {
                    menu.addSeparator();
                    menu.addItem((item) =>
                        item
                            .setTitle("Delete")
                            .setIcon("trash-2")
                            .setWarning(true)
                            .onClick(() => void this.deleteProfile(id, profile.name)),
                    );
                }
                menu.showAtPosition({ x: actions.getBoundingClientRect().left, y: actions.getBoundingClientRect().bottom });
            });
    }

    private renderDeviceDefault(label: string, type: DeviceType, currentId: string) {
        new Setting(this.containerEl).setName(label).addDropdown((dropdown) => {
            Object.values(this.plugin.data.profiles).forEach((profile) => dropdown.addOption(profile.id, profile.name));
            dropdown.setValue(currentId).onChange(async (profileId) => {
                await this.tab.saveImmediateChanges((data) => {
                    if (type === "desktop") data.desktopProfileId = profileId;
                    else data.mobileProfileId = profileId;
                });
                this.display();
            });
        });
    }

    private async switchProfile(id: string) {
        await this.tab.waitForImmediateSaves();
        if (this.tab.hasPendingChanges) {
            if (!(await showConfirmModal(this.app, { message: "You have unsaved changes. Switch profile anyway?" }))) return;
            // Reload first so switchProfile cannot persist the discarded draft while
            // it saves the newly selected profile and device default.
            await this.tab.discardPendingChanges(false);
        }
        await this.plugin.switchProfile(id);
        this.tab.resetPending();
        this.display();
    }

    private openNameModal(id: string, currentName: string) {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Rename profile");
        let name = currentName;
        new Setting(modal.contentEl).setName("Profile name").addText((text) => text.setValue(currentName).onChange((value) => (name = value)));
        new Setting(modal.contentEl).addButton((button) =>
            button
                .setButtonText("Save")
                .setCta()
                .onClick(async () => {
                    const nextName = name.trim();
                    if (!nextName) return;
                    // Renaming to the same name changes nothing, so keep the draft clean.
                    if (nextName === this.plugin.data.profiles[id]?.name) {
                        modal.close();
                        return;
                    }
                    await this.tab.saveImmediateChanges((data) => {
                        data.profiles[id].name = nextName;
                    });
                    modal.close();
                    this.display();
                }),
        );
        modal.open();
    }

    private async createProfile() {
        const name = this.createName.trim();
        if (!name) return;
        await this.tab.createProfile(name);
        this.createName = "";
        this.display();
    }

    private async deleteProfile(id: string, name: string) {
        if (id === this.plugin.data.desktopProfileId || id === this.plugin.data.mobileProfileId) {
            new Notice("Assign another device default before deleting this profile.");
            return;
        }
        // Keep the install-time recovery profile behind an explicit warning so a
        // destructive click does not silently remove the user's fallback copy.
        const message = id === "initial-backup" ? `WARNING: \"${name}\" is your failsafe initial backup. It is highly recommended to keep it. Are you absolutely sure you want to delete it?` : `Delete profile \"${name}\"?`;
        if (!(await showConfirmModal(this.app, { message }))) return;
        await this.tab.saveImmediateChanges((data) => {
            delete data.profiles[id];
        });
        this.display();
    }
}

function profileIdsFor(host: Pick<SettingsUiHost, "data">) {
    return Object.keys(host.data.profiles);
}
/* eslint-enable @typescript-eslint/no-misused-promises, no-useless-escape -- End of the async-handler bridge. */
