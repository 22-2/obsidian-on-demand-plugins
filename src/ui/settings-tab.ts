/* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, no-useless-escape -- Declarative settings callbacks intentionally bridge Obsidian's void handlers and plugin async persistence. */
import type { App, ButtonComponent, DropdownComponent, SettingDefinitionItem } from "obsidian";
import { ExtraButtonComponent, FileSystemAdapter, Menu, Modal, Notice, Platform, PluginSettingTab, Setting, SettingPage, normalizePath } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { FeatureEvents } from "src/core/event-bus";
import type { PLUGIN_MODE } from "src/core/types";
import { PluginModes } from "src/core/types";
import type { MaintenanceFeature, SyncDirection } from "src/features/maintenance/maintenance-feature";
import { MaintenanceFeature as MaintenanceFeatureClass } from "src/features/maintenance/maintenance-feature";
import type OnDemandPlugin from "src/main";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";

async function openBackupDirectory(plugin: OnDemandPlugin) {
    if (!Platform.isDesktopApp || !(plugin.app.vault.adapter instanceof FileSystemAdapter)) {
        new Notice("Opening the backup folder is available on desktop only.");
        return;
    }

    const adapter = plugin.app.vault.adapter;
    const backupPath = normalizePath(`${plugin.manifest.dir}/backups`);
    try {
        if (!(await adapter.exists(backupPath))) await adapter.mkdir(backupPath);
        const electron = (window as Window & { require?: (moduleName: string) => unknown }).require?.("electron") as { shell?: { openPath: (path: string) => Promise<string> } } | undefined;
        const error = await electron?.shell?.openPath(`${adapter.getBasePath()}/${backupPath}`);
        if (error) new Notice(`Could not open the backup folder: ${error}`);
    } catch (error) {
        new Notice(`Could not open the backup folder: ${error instanceof Error ? error.message : String(error)}`);
    }
}

class ProfileManagementPage extends SettingPage {
    private app: App;
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private createName = "";

    constructor(app: App, plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.tab = tab;
    }

    display() {
        this.containerEl.empty();
        this.containerEl.addClass("lazy-profile-page");
        this.tab.renderPendingControls(this.containerEl, () => this.display());
        const service = this.plugin.core.settingsService;
        const profileIds = Object.keys(service.data.profiles);

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
        this.renderDeviceDefault("Desktop", "desktop", service.data.desktopProfileId);
        this.renderDeviceDefault("Mobile", "mobile", service.data.mobileProfileId);
    }

    private renderProfileCard(list: HTMLElement, id: string) {
        const service = this.plugin.core.settingsService;
        const profile = service.data.profiles[id];
        const isCurrent = id === service.currentProfileId;
        const isDesktopDefault = id === service.data.desktopProfileId;
        const isMobileDefault = id === service.data.mobileProfileId;
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
                            service.createProfile(`${profile.name} (Copy)`, id);
                            this.tab.markDirty();
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
                if (profileIdsFor(service).length > 1 && !isCurrent) {
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

    private renderDeviceDefault(label: string, type: "desktop" | "mobile", currentId: string) {
        const service = this.plugin.core.settingsService;
        new Setting(this.containerEl).setName(label).addDropdown((dropdown) => {
            Object.values(service.data.profiles).forEach((profile) => dropdown.addOption(profile.id, profile.name));
            dropdown.setValue(currentId).onChange(async (profileId) => {
                service.setDeviceDefault(profileId, type);
                this.tab.markDirty();
                this.display();
            });
        });
    }

    private async switchProfile(id: string) {
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
                    if (!name.trim()) return;
                    const service = this.plugin.core.settingsService;
                    service.renameProfile(id, name.trim());
                    this.tab.markDirty();
                    modal.close();
                    this.display();
                }),
        );
        modal.open();
    }

    private async createProfile() {
        const name = this.createName.trim();
        if (!name) return;
        this.plugin.core.settingsService.createProfile(name);
        this.tab.markDirty();
        this.createName = "";
        this.display();
    }

    private async deleteProfile(id: string, name: string) {
        const service = this.plugin.core.settingsService;
        if (id === service.data.desktopProfileId || id === service.data.mobileProfileId) {
            new Notice("Assign another device default before deleting this profile.");
            return;
        }
        // Keep the install-time recovery profile behind an explicit warning so a
        // destructive click does not silently remove the user's fallback copy.
        const message = id === "initial-backup" ? `WARNING: \"${name}\" is your failsafe initial backup. It is highly recommended to keep it. Are you absolutely sure you want to delete it?` : `Delete profile \"${name}\"?`;
        if (!(await showConfirmModal(this.app, { message }))) return;
        service.deleteProfile(id);
        this.tab.markDirty();
        this.display();
    }
}

function profileIdsFor(service: OnDemandPlugin["core"]["settingsService"]) {
    return Object.keys(service.data.profiles);
}

class PluginPage extends SettingPage {
    private static readonly PAGE_SIZE = 24;
    private filter = "";
    private mode?: PLUGIN_MODE;
    private app: App;
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private infiniteScrollObserver?: IntersectionObserver;
    private loadedCount = 0;
    constructor(app: App, plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.tab = tab;
    }
    display() {
        this.disconnectInfiniteScroll();
        // Plugin installations can happen while the settings modal is open.
        // Refresh the registry whenever this page is entered so the count and
        // list reflect the current Obsidian plugin manifests.
        this.plugin.updateManifests();
        this.containerEl.empty();
        this.tab.renderPendingControls(this.containerEl, () => this.display());
        new Setting(this.containerEl)
            .setName("Plugins")
            .setHeading()
            .addExtraButton((button) =>
                button
                    .setIcon("refresh-cw")
                    .setTooltip("Refresh plugin list")
                    .onClick(() => {
                        this.plugin.updateManifests();
                        this.tab.update();
                    }),
            );
        new Setting(this.containerEl)
            .setName("Filter")
            .addText((t) =>
                t
                    .setPlaceholder("Plugin name")
                    .setValue(this.filter)
                    .onChange((v) => {
                        this.filter = v;
                        this.renderInfiniteList();
                    }),
            )
            .addDropdown((d) => {
                d.addOption("", "All");
                Object.keys(PluginModes).forEach((k) => d.addOption(k, PluginModes[k as PLUGIN_MODE]));
                d.setValue(this.mode ?? "").onChange((v) => {
                    this.mode = v ? (v as PLUGIN_MODE) : undefined;
                    this.renderInfiniteList();
                });
            });
        this.containerEl.createDiv({ cls: "lazy-plugin-infinite-host" });
        this.renderInfiniteList();
    }
    hide() {
        this.disconnectInfiniteScroll();
        super.hide();
    }
    private renderInfiniteList() {
        this.disconnectInfiniteScroll();
        const host = this.containerEl.querySelector<HTMLElement>(".lazy-plugin-infinite-host");
        if (!host) return;
        host.empty();
        const plugins = this.plugin.manifests.filter((manifest) => (!this.filter || manifest.name.toLowerCase().includes(this.filter.toLowerCase())) && (!this.mode || this.plugin.getPluginMode(manifest.id) === this.mode));
        host.createDiv({ cls: "lazy-plugin-results-count", text: `${plugins.length} plugins` });
        const listEl = host.createDiv({ cls: "lazy-plugin-list-body" });
        this.loadedCount = Math.min(PluginPage.PAGE_SIZE, plugins.length);
        this.appendPluginRows(listEl, plugins, 0, this.loadedCount);
        if (this.loadedCount >= plugins.length) return;
        const sentinel = host.createDiv({ cls: "lazy-plugin-infinite-sentinel", attr: { "aria-hidden": "true" } });
        const activeWindow = host.ownerDocument.defaultView;
        if (!activeWindow) return;
        this.infiniteScrollObserver = new activeWindow.IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                const previousCount = this.loadedCount;
                this.loadedCount = Math.min(this.loadedCount + PluginPage.PAGE_SIZE, plugins.length);
                this.appendPluginRows(listEl, plugins, previousCount, this.loadedCount);
                if (this.loadedCount >= plugins.length) {
                    this.disconnectInfiniteScroll();
                    sentinel.remove();
                }
            },
            { rootMargin: "300px 0px" },
        );
        this.infiniteScrollObserver.observe(sentinel);
    }
    private appendPluginRows(listEl: HTMLElement, plugins: OnDemandPlugin["manifests"], start: number, end: number) {
        plugins.slice(start, end).forEach((manifest) => {
            if (!manifest) return;
            const setting = new Setting(listEl).setName(manifest.name);
            setting.setDesc(manifest.description);
            new ExtraButtonComponent(setting.controlEl)
                .setIcon("gear")
                .setTooltip("Advanced lazy options")
                .onClick(() =>
                    new LazyOptionsModal(this.app, this.plugin, manifest.id, () => {
                        this.tab.pendingPluginIds.add(manifest.id);
                        this.tab.markDirty();
                        this.tab.renderPendingControls(this.containerEl, () => this.display());
                    }).open(),
                );
            setting.addDropdown((dropdown) => {
                Object.keys(PluginModes).forEach((key) => dropdown.addOption(key, PluginModes[key as PLUGIN_MODE]));
                dropdown.setValue(this.plugin.getPluginMode(manifest.id)).onChange((value) => {
                    // Changing the mode should preserve advanced lazy options so
                    // users can temporarily disable a plugin without reconfiguring it.
                    this.plugin.settings.plugins[manifest.id] = {
                        ...(this.plugin.settings.plugins[manifest.id] ?? {}),
                        mode: value as PLUGIN_MODE,
                        userConfigured: true,
                    };
                    this.tab.pendingPluginIds.add(manifest.id);
                    this.tab.markDirty();
                    // Re-apply an active filter after a mode change so rows and the
                    // result count do not show plugins that no longer match it.
                    this.renderInfiniteList();
                    this.tab.renderPendingControls(this.containerEl, () => this.display());
                });
            });
        });
    }
    private disconnectInfiniteScroll() {
        this.infiniteScrollObserver?.disconnect();
        this.infiniteScrollObserver = undefined;
    }
}

class MaintenancePage extends SettingPage {
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private from = "alwaysDisabled" as PLUGIN_MODE;
    private to = "lazy" as PLUGIN_MODE;
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
        const f = this.plugin.features.get(MaintenanceFeatureClass) as MaintenanceFeature | undefined;
        new Setting(this.containerEl).setName("Cache maintenance").setHeading();
        new Setting(this.containerEl).setName("Force rebuild command cache").addButton((b) =>
            b
                .setButtonText("Rebuild cache")
                .setWarning()
                .onClick(async () => {
                    if (!f) return;
                    b.setDisabled(true);
                    try {
                        await f.rebuildAndApplyCommandCache({ force: true });
                        new Notice("Command cache rebuilt successfully");
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
            this.modes(d)
                .setValue(this.from)
                .onChange((v) => (this.from = v as PLUGIN_MODE)),
        );
        new Setting(this.containerEl)
            .setName("To mode")
            .addButton((b) =>
                b
                    .setButtonText("Replace all")
                    .setWarning()
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
                this.modes(d)
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
    private modes(d: DropdownComponent) {
        Object.keys(PluginModes).forEach((k) => d.addOption(k, PluginModes[k as PLUGIN_MODE]));
        return d;
    }
}

export class SettingsTab extends PluginSettingTab {
    pendingPluginIds = new Set<string>();
    private dirty = false;
    public plugin: OnDemandPlugin;
    constructor(app: App, plugin: OnDemandPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    get hasPendingChanges() {
        return this.dirty || this.pendingPluginIds.size > 0;
    }
    getControlValue(key: string) {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }
    setControlValue(key: string, value: unknown) {
        (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
        // Keep declarative controls on the same draft lifecycle as plugin modes;
        // otherwise Save/Discard cannot provide an atomic, predictable result.
        this.markDirty();
        this.update();
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        this.plugin.updateManifests();
        const modes = Object.fromEntries(Object.keys(PluginModes).map((key) => [key, PluginModes[key as PLUGIN_MODE]]));
        return [
            { type: "page", name: "Profile management", desc: "Manage profiles and device defaults.", page: () => new ProfileManagementPage(this.app, this.plugin, this) },
            { type: "page", name: "Plugin management", desc: "Configure plugin loading modes.", displayValue: () => `${this.plugin.manifests.length} plugins`, page: () => new PluginPage(this.app, this.plugin, this) },
            {
                type: "page",
                name: "Behaviour",
                desc: "Configure default loading behaviour.",
                items: [
                    {
                        name: "Changes",
                        desc: "Settings changes are staged until you save them.",
                        render: (setting) => this.configurePendingControls(setting),
                    },
                    { name: "Default mode", desc: "Default mode for newly discovered plugins.", control: { type: "dropdown", key: "defaultMode", options: modes } },
                    {
                        name: "Auto-remove uninstalled entries",
                        desc: "Prune settings for plugins that are no longer installed.",
                        render: (setting) => {
                            setting.addToggle((toggle) =>
                                toggle.setValue(this.plugin.settings.pruneUninstalledEntries).onChange(async (value) => {
                                    this.plugin.settings.pruneUninstalledEntries = value;
                                    this.markDirty();
                                    try {
                                        // Back up before pruning so enabling cleanup never loses
                                        // the stale entries before the user can save the draft.
                                        if (value) await this.plugin.backupAndPruneUninstalledEntries();
                                    } finally {
                                        this.update();
                                    }
                                }),
                            );
                        },
                    },
                ],
            },
            { type: "page", name: "Maintenance & batch", desc: "Rebuild caches and apply batch operations.", page: () => new MaintenancePage(this.plugin, this) },
        ];
    }
    markDirty() {
        this.dirty = true;
    }
    configurePendingControls(setting: Setting, onRefresh?: () => void) {
        setting
            .setClass("lazy-plugin-save-controls")
            .setName("Changes")
            .setDesc("Settings changes are staged until you save them. Plugin mode changes are applied when saved.")
            .addButton((button) =>
                button
                    .setButtonText(this.pendingPluginIds.size > 0 ? `Save & apply (${this.pendingPluginIds.size})` : "Save changes")
                    .setCta()
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(async () => {
                        await this.saveChanges();
                        onRefresh?.();
                    }),
            )
            .addButton((button) =>
                button
                    .setButtonText("Discard")
                    .setDisabled(!this.hasPendingChanges)
                    .onClick(async () => {
                        if (await this.discardChanges()) onRefresh?.();
                    }),
            );
    }
    renderPendingControls(container: HTMLElement, onRefresh?: () => void) {
        container.querySelector(".lazy-plugin-save-controls")?.remove();
        const setting = new Setting(container);
        this.configurePendingControls(setting, onRefresh);
        container.prepend(setting.settingEl);
    }
    resetPending() {
        this.dirty = false;
        this.pendingPluginIds.clear();
    }
    async saveChanges() {
        if (!this.hasPendingChanges) return;
        const pluginIds = Array.from(this.pendingPluginIds);
        await this.plugin.saveSettings();
        if (pluginIds.length > 0) {
            await this.plugin.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds });
        }
        this.resetPending();
        new Notice(pluginIds.length > 0 ? "Settings saved and applied" : "Settings saved");
        this.update();
    }
    async discardPendingChanges(refresh = true) {
        await this.plugin.loadSettings();
        // Debug logging is applied at runtime, so restore it after reloading the
        // persisted draft when the user discards changes.
        this.plugin.configureLogger();
        this.resetPending();
        if (refresh) this.update();
    }
    async discardChanges(): Promise<boolean> {
        if (!(await showConfirmModal(this.app, { message: "Discard all unsaved changes?" }))) return false;
        await this.discardPendingChanges();
        new Notice("Changes discarded");
        return true;
    }
}

/* eslint-enable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, no-useless-escape -- End of the intentionally compact declarative settings implementation. */
