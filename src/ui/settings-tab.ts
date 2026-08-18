/* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, no-useless-escape -- Declarative settings callbacks intentionally bridge Obsidian's void handlers and plugin async persistence. */
import type { App, DropdownComponent, SettingDefinitionItem } from "obsidian";
import { ExtraButtonComponent, Menu, Notice, PluginSettingTab, Setting, SettingPage } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { FeatureEvents } from "src/core/event-bus";
import type { PLUGIN_MODE } from "src/core/types";
import { PluginModes } from "src/core/types";
import type { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import { MaintenanceFeature as MaintenanceFeatureClass } from "src/features/maintenance/maintenance-feature";
import type { SyncDirection } from "src/features/maintenance/maintenance-feature";
import type OnDemandPlugin from "src/main";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";

class ProfilePage extends SettingPage {
    private app: App;
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    constructor(app: App, plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.tab = tab;
    }
    display() {
        this.containerEl.empty();
        const s = this.plugin.core.settingsService;
        new Setting(this.containerEl).setName("Active profile").addDropdown((d) => {
            Object.values(s.data.profiles).forEach((p) => d.addOption(p.id, p.name));
            d.setValue(s.currentProfileId).onChange((id) => void this.switchProfile(id, d));
        });
        const list = this.containerEl.createDiv({ cls: "lazy-profile-list" });
        const ids = Object.keys(s.data.profiles);
        ids.forEach((id) => {
            const p = s.data.profiles[id];
            const row = list.createDiv({ cls: "lazy-profile-row" });
            const info = row.createDiv({ cls: "lazy-profile-info" });
            info.createDiv({ cls: "lazy-profile-name", text: p.name });
            const tags = [id === s.currentProfileId ? "Active" : "", id === s.data.desktopProfileId ? "Desktop default" : "", id === s.data.mobileProfileId ? "Mobile default" : "", id === "initial-backup" ? "Initial Backup" : ""].filter(Boolean);
            info.createDiv({ cls: "lazy-profile-meta", text: tags.join(" • ") });
            const actions = row.createDiv({ cls: "lazy-profile-actions" });
            new ExtraButtonComponent(actions)
                .setIcon("ellipsis-vertical")
                .setTooltip("More options")
                .onClick(() => {
                    const menu = new Menu();
                    menu.addItem((i) => i.setTitle("Rename").onClick(() => this.editName(id, p.name)));
                    menu.addItem((i) =>
                        i.setTitle("Duplicate").onClick(async () => {
                            s.createProfile(`${p.name} (Copy)`, id);
                            await s.save();
                            this.display();
                        }),
                    );
                    menu.addSeparator();
                    menu.addItem((i) =>
                        i
                            .setTitle("Set as desktop default")
                            .setDisabled(id === s.data.desktopProfileId)
                            .onClick(async () => {
                                s.setDeviceDefault(id, "desktop");
                                await s.save();
                                this.display();
                            }),
                    );
                    menu.addItem((i) =>
                        i
                            .setTitle("Set as mobile default")
                            .setDisabled(id === s.data.mobileProfileId)
                            .onClick(async () => {
                                s.setDeviceDefault(id, "mobile");
                                await s.save();
                                this.display();
                            }),
                    );
                    if (ids.length > 1 && id !== s.currentProfileId) menu.addItem((i) => i.setTitle("Delete").onClick(() => void this.remove(id, p.name)));
                    menu.showAtPosition({ x: actions.getBoundingClientRect().left, y: actions.getBoundingClientRect().bottom });
                });
        });
        new Setting(this.containerEl).setName("Create new profile").addButton((b) =>
            b
                .setButtonText("Create")
                .setCta()
                .onClick(() => this.editName()),
        );
    }
    private async switchProfile(id: string, d: DropdownComponent) {
        const s = this.plugin.core.settingsService;
        if (id === s.currentProfileId) return;
        if (this.tab.hasPendingChanges && !(await showConfirmModal(this.app, { message: "You have unsaved changes. Switch profile anyway?" }))) return void d.setValue(s.currentProfileId);
        await this.plugin.switchProfile(id);
        this.tab.resetPending();
        this.display();
    }
    private editName(id?: string, current = "") {
        const input = this.containerEl.createEl("input", { type: "text", value: current, placeholder: "Profile name" });
        const b = this.containerEl.createEl("button", { text: id ? "Save" : "Create" });
        b.onclick = async () => {
            if (!input.value.trim()) return;
            const s = this.plugin.core.settingsService;
            if (id) s.renameProfile(id, input.value.trim());
            else s.createProfile(input.value.trim());
            await s.save();
            input.remove();
            b.remove();
            this.display();
        };
    }
    private async remove(id: string, name: string) {
        const s = this.plugin.core.settingsService;
        if (id === s.data.desktopProfileId || id === s.data.mobileProfileId) return void new Notice("Assign another default profile first.");
        if (await showConfirmModal(this.app, { message: `Delete profile \"${name}\"?` })) {
            s.deleteProfile(id);
            await s.save();
            this.display();
        }
    }
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
        this.containerEl.empty();
        this.renderSaveControls();
        new Setting(this.containerEl).setName("Plugins").setHeading();
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
    private renderSaveControls() {
        const existing = this.containerEl.querySelector(".lazy-plugin-save-controls");
        existing?.remove();
        const setting = new Setting(this.containerEl)
            .setClass("lazy-plugin-save-controls")
            .setName("Changes")
            .setDesc("Plugin mode changes are staged until you save and apply them.")
            .addButton((b) =>
                b
                    .setButtonText(this.tab.hasPendingChanges ? `Save & apply (${this.tab.pendingPluginIds.size})` : "Save changes")
                    .setCta()
                    .setDisabled(!this.tab.hasPendingChanges)
                    .onClick(() => void this.tab.saveChanges()),
            )
            .addButton((b) =>
                b
                    .setButtonText("Discard")
                    .setDisabled(!this.tab.hasPendingChanges)
                    .onClick(() => void this.tab.discardChanges()),
            );
        this.containerEl.prepend(setting.settingEl);
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
                        this.renderSaveControls();
                    }).open(),
                );
            setting.addDropdown((dropdown) => {
                Object.keys(PluginModes).forEach((key) => dropdown.addOption(key, PluginModes[key as PLUGIN_MODE]));
                dropdown.setValue(this.plugin.getPluginMode(manifest.id)).onChange((value) => {
                    this.plugin.settings.plugins[manifest.id] = { mode: value as PLUGIN_MODE, userConfigured: true };
                    this.tab.pendingPluginIds.add(manifest.id);
                    this.tab.markDirty();
                    this.renderSaveControls();
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
                        const result = await f.executeSync(this.syncDirection);
                        new Notice(result.message);
                        if (result.changed > 0) this.tab.update();
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
                        const n = f.applyBatchModeReplace(this.from, this.to);
                        if (n) {
                            this.tab.markDirty();
                            new Notice(`Staged ${n} plugin changes. Save from Plugin management.`);
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
                await this.plugin.saveSettings();
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
        void this.plugin.saveSettings();
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        this.plugin.updateManifests();
        const modes = Object.fromEntries(Object.keys(PluginModes).map((key) => [key, PluginModes[key as PLUGIN_MODE]]));
        return [
            { type: "page", name: "Profile management", desc: "Manage profiles and device defaults.", page: () => new ProfilePage(this.app, this.plugin, this) },
            { type: "page", name: "Plugin management", desc: "Configure plugin loading modes.", displayValue: () => `${this.plugin.manifests.length} plugins`, page: () => new PluginPage(this.app, this.plugin, this) },
            {
                type: "page",
                name: "Behaviour",
                desc: "Configure default loading behaviour.",
                items: [
                    { name: "Default mode", desc: "Default mode for newly discovered plugins.", control: { type: "dropdown", key: "defaultMode", options: modes } },
                    {
                        name: "Auto-remove uninstalled entries",
                        desc: "Prune settings for plugins that are no longer installed.",
                        render: (setting) => {
                            setting.addToggle((toggle) =>
                                toggle.setValue(this.plugin.settings.pruneUninstalledEntries).onChange(async (value) => {
                                    this.plugin.settings.pruneUninstalledEntries = value;
                                    if (value) await this.plugin.backupAndPruneUninstalledEntries();
                                    await this.plugin.saveSettings();
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
    resetPending() {
        this.dirty = false;
        this.pendingPluginIds.clear();
    }
    async saveChanges() {
        if (!this.hasPendingChanges) return;
        await this.plugin.saveSettings();
        await this.plugin.events.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds: Array.from(this.pendingPluginIds) });
        this.resetPending();
        new Notice("Settings saved and applied");
        this.update();
    }
    async discardChanges() {
        if (!(await showConfirmModal(this.app, { message: "Discard all unsaved changes?" }))) return;
        await this.plugin.loadSettings();
        this.resetPending();
        this.update();
        new Notice("Changes discarded");
    }
}

/* eslint-enable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, no-useless-escape -- End of the intentionally compact declarative settings implementation. */
