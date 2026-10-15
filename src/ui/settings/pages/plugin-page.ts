import log from "loglevel";
import type { App, EventRef, PluginManifest } from "obsidian";
import { ExtraButtonComponent, Menu, Notice, Setting, SettingPage, ToggleComponent, setTooltip } from "obsidian";
import { PLUGIN_LOAD_STATE_CHANGED_EVENT } from "src/core/constants";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import { PLUGIN_MODE } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import type OnDemandPlugin from "src/main";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";
import { addPluginRowMenuItems } from "src/ui/plugin-row-menu";
import { showInCommunityPlugins } from "src/ui/show-in-community-plugins";
import type { SettingsTab } from "src/ui/settings-tab";
import { addModeOptions, enabledBadgeText, getPluginStatistics, openPluginDirectory, pluginModeLabel, pluginStatisticsText } from "src/ui/settings/helpers";
import { createSettingsNotice } from "src/ui/settings/settings-notice";

const logger = log.getLogger("OnDemandPlugin/PluginPage");
const COMPACT_LIST_STORAGE_KEY = "compact-plugin-list";

// Badge words sit in their own span so the compact list can hide them and keep only the icon or dot.
// The full text stays in the tooltip for the hidden words.
function setModeBadgeText(badge: HTMLElement, label: string) {
    const [icon, ...words] = label.split(" ");
    badge.empty();
    badge.createSpan({ cls: "lazy-plugin-badge-icon", text: icon });
    badge.createSpan({ cls: "lazy-plugin-badge-text", text: ` ${words.join(" ")}` });
    setTooltip(badge, label);
}

function setStatusBadgeText(badge: HTMLElement, text: string) {
    badge.empty();
    badge.createSpan({ cls: "lazy-plugin-badge-text", text });
    setTooltip(badge, text);
}

function setEnabledBadgeState(badge: HTMLElement, app: App, pluginId: string, savedPluginIds?: ReadonlySet<string>) {
    const loaded = isPluginLoaded(app, pluginId);
    const status = enabledBadgeText(app, pluginId, savedPluginIds);
    setStatusBadgeText(badge, status);
    badge.toggleClass("is-loaded", loaded);
    badge.toggleClass("is-memory-only", loaded && savedPluginIds !== undefined && !savedPluginIds.has(pluginId));
}

export class PluginPage extends SettingPage {
    private static readonly PAGE_SIZE = 24;
    private filter = "";
    private mode?: PLUGIN_MODE;
    // Kept in vault-scoped local storage, not in the staged settings draft, so it saves at once.
    private compact = false;
    private app: App;
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private infiniteScrollObserver?: IntersectionObserver;
    private loadedCount = 0;
    private savedCommunityPluginIds?: Set<string>;
    private communityPluginReadId = 0;
    private loadStateRef?: EventRef;
    constructor(app: App, plugin: OnDemandPlugin, tab: SettingsTab) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.tab = tab;
        this.compact = loadLocalStorage<boolean>(app, COMPACT_LIST_STORAGE_KEY) === true;
    }
    display() {
        this.disconnectInfiniteScroll();
        this.tab.offerRestoreOnPluginManagementOpen();
        this.watchPluginLoadState();
        // Plugin installations can happen while the settings modal is open.
        // Refresh the registry whenever this page is entered so the count and
        // list reflect the current Obsidian plugin manifests.
        this.plugin.updateManifests();
        void this.refreshCommunityPluginSnapshot();
        this.containerEl.empty();
        this.tab.renderPendingControls(this.containerEl, () => this.display());
        createSettingsNotice(this.containerEl, "lazy-plugin-changes-notice", (text) => {
            text.setText("Changes apply only after you select save in the review dialog.");
        });
        new Setting(this.containerEl).setName("Overview").setHeading();
        new Setting(this.containerEl)
            .setName(pluginStatisticsText(this.plugin))
            .setDesc(`${getPluginStatistics(this.plugin).total} plugins total · disabled / on demand / on layout ready / enabled`)
            .setClass("lazy-plugin-statistics");
        // Phones show the refresh control on the heading's right; desktop shows it beside the filters (see CSS).
        new Setting(this.containerEl)
            .setName("Plugins")
            .setHeading()
            .addExtraButton((button) => {
                button.extraSettingsEl.addClass("lazy-plugin-refresh-mobile");
                button
                    .setIcon("refresh-cw")
                    .setTooltip("Refresh plugin list")
                    .onClick(() => this.refreshList());
            });
        // No row name: the placeholder already says what the field is, and a name column only leaves a gap.
        const filterSetting = new Setting(this.containerEl);
        filterSetting.setClass("lazy-plugin-filter-row");
        filterSetting
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
                addModeOptions(d);
                d.setValue(this.mode ?? "").onChange((v) => {
                    this.mode = v ? (v as PLUGIN_MODE) : undefined;
                    this.renderInfiniteList();
                });
            })
            // Beside the filters, so the refresh control lines up with the mode dropdown instead of the heading.
            .addExtraButton((button) => {
                button.extraSettingsEl.addClass("lazy-plugin-refresh-desktop");
                button
                    .setIcon("refresh-cw")
                    .setTooltip("Refresh plugin list")
                    .onClick(() => this.refreshList());
            });
        this.containerEl.createDiv({ cls: "lazy-plugin-infinite-host" });
        this.renderInfiniteList();
    }
    private refreshList() {
        this.plugin.updateManifests();
        void this.refreshCommunityPluginSnapshot();
        // Re-render the list directly: tab.update() does not
        // guarantee the open page is re-displayed, so relying
        // on it leaves live badges (e.g. Enabled after an
        // on-demand load) stale.
        this.renderInfiniteList();
    }
    hide() {
        this.disconnectInfiniteScroll();
        this.unwatchPluginLoadState();
        this.communityPluginReadId++;
        super.hide();
    }
    private renderInfiniteList() {
        this.disconnectInfiniteScroll();
        const host = this.containerEl.querySelector<HTMLElement>(".lazy-plugin-infinite-host");
        if (!host) return;
        host.empty();
        // Mobile keyboards often append a space after a completed name; normalize
        // only the query so typing and internal spaces in plugin names stay intact.
        const query = this.filter.trim().toLowerCase();
        const plugins = this.plugin.manifests.filter((manifest) => (!query || manifest.name.toLowerCase().includes(query)) && (!this.mode || this.plugin.getPluginMode(manifest.id) === this.mode));
        // The compact toggle sits at the right edge of the count line. It has no visible label,
        // so its tooltip supplies the accessible name.
        const toolbar = host.createDiv({ cls: "lazy-plugin-list-toolbar" });
        const compactControl = toolbar.createDiv({ cls: "lazy-plugin-compact-control" });
        compactControl.createSpan({ text: "Compact list" });
        new ToggleComponent(compactControl)
            .setValue(this.compact)
            .setTooltip("Compact list")
            .onChange((value) => {
                this.compact = value;
                saveLocalStorage(this.app, COMPACT_LIST_STORAGE_KEY, value);
                this.renderInfiniteList();
            });
        toolbar.createDiv({ cls: "lazy-plugin-results-count", text: `${plugins.length} plugins` });
        const listEl = host.createDiv({ cls: "lazy-plugin-list-body" });
        listEl.toggleClass("is-compact", this.compact);
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
            setting.setClass("lazy-plugin-mode-row");
            // Give variable-length descriptions their own line so metadata
            // always starts at a predictable position within each row.
            setting.descEl.createDiv({ cls: "lazy-plugin-description", text: manifest.description });
            // The current mode lives in passive badges so the row never owns
            // an editable control; edits go through the 3-dot menu instead.
            const badges = setting.descEl.createDiv({ cls: "lazy-plugin-badges" });
            const mode = this.plugin.getPluginMode(manifest.id);
            const modeBadge = badges.createSpan({ cls: "lazy-plugin-mode-badge" });
            setModeBadgeText(modeBadge, pluginModeLabel(mode));
            // Show the live runtime state; the staged mode alone cannot tell
            // whether a lazy plugin is actually loaded right now.
            const enabledBadge = badges.createSpan({ cls: "lazy-plugin-enabled-badge" });
            setEnabledBadgeState(enabledBadge, this.app, manifest.id, this.savedCommunityPluginIds);
            enabledBadge.setAttr("data-plugin-id", manifest.id);
            // The version sits beside the plugin name, as a sibling so the name text stays exact.
            setting.nameEl.after(createSpan({ cls: "lazy-plugin-version", text: `v${manifest.version}` }));
            // Author names vary widely in length, so they keep their own line on the badge row.
            const author = manifest.author?.trim();
            if (author) {
                setting.descEl.createDiv({ cls: "lazy-plugin-meta-badge", text: `by ${author}` });
            }
            const actionsButton = new ExtraButtonComponent(setting.controlEl).setIcon("ellipsis-vertical").setTooltip("Plugin actions");
            actionsButton.extraSettingsEl.addClass("lazy-plugin-row-actions-desktop");
            // Both controls open the same menu; anchor it to the visible control
            // because ExtraButtonComponent callbacks do not provide a MouseEvent.
            // A second press on the control closes its open menu instead of opening another.
            let openMenu: Menu | undefined;
            // Obsidian hides a menu on an outside mousedown, so the following click
            // would reopen it; keep that mousedown here and let the click close it.
            const keepMenuForClick = (evt: MouseEvent) => {
                if (openMenu) evt.stopPropagation();
            };
            const openActions = (anchor: HTMLElement) => {
                if (openMenu) {
                    openMenu.hide();
                    return;
                }
                const menu = new Menu();
                menu.onHide(() => (openMenu = undefined));
                openMenu = menu;
                addPluginRowMenuItems(menu, {
                    getMode: () => this.plugin.getPluginMode(manifest.id),
                    isEnabled: () => isPluginLoaded(this.app, manifest.id),
                    onOpenDetails: () =>
                        new LazyOptionsModal(this.app, this.plugin, manifest.id, () => {
                            this.tab.pendingPluginIds.add(manifest.id);
                            this.tab.markDirty();
                            this.tab.renderPendingControls(this.containerEl, () => this.display());
                        }).open(),
                    onShowInCommunityPlugins: () => showInCommunityPlugins(this.app, manifest.id),
                    onRevealInExplorer: () => void openPluginDirectory(this.app, manifest),
                    onToggleEnabled: (enabled) => void this.applyRuntimeToggle(manifest, enabled, enabledBadge),
                    onSelectMode: (mode) => this.applyRowModeChange(manifest.id, mode, modeBadge, enabledBadge),
                });
                const rect = anchor.getBoundingClientRect();
                // Settings can live in a separate window; use its document so the
                // menu and anchor coordinates refer to the same visible surface.
                menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
            };
            actionsButton.extraSettingsEl.addEventListener("mousedown", keepMenuForClick);
            actionsButton.onClick(() => openActions(actionsButton.extraSettingsEl));
            // A labeled native button makes the mobile action easier to discover
            // and press while sharing the desktop menu's behavior.
            setting.addButton((button) => {
                button.buttonEl.addEventListener("mousedown", keepMenuForClick);
                button.setIcon("ellipsis-vertical").onClick(() => openActions(button.buttonEl));
                // setIcon replaces button contents, so append the label afterward.
                button.buttonEl.createSpan({ text: "Actions" });
                button.buttonEl.addClass("lazy-plugin-row-actions-mobile");
            });
        });
    }
    /**
     * Enables or disables the plugin in memory only. Unlike a mode change, this does
     * not stage a settings draft, so it never needs "Save & apply" and resets on restart.
     */
    private async applyRuntimeToggle(manifest: PluginManifest, enabled: boolean, enabledBadge: HTMLElement) {
        try {
            if (enabled) {
                await this.app.plugins.enablePlugin(manifest.id);
            } else {
                await this.app.plugins.disablePlugin(manifest.id);
            }
        } catch (error) {
            logger.error(`Failed to ${enabled ? "enable" : "disable"} plugin ${manifest.id}`, error);
            new Notice(`Failed to ${enabled ? "enable" : "disable"} ${manifest.name}`);
        }
        setEnabledBadgeState(enabledBadge, this.app, manifest.id, this.savedCommunityPluginIds);
    }

    private applyRowModeChange(pluginId: string, mode: PLUGIN_MODE, modeBadge: HTMLElement, enabledBadge: HTMLElement) {
        // Selecting the effective mode changes nothing semantically, so skip creating
        // an explicit entry just to flip userConfigured and keep the draft clean.
        const current = this.plugin.settings.plugins[pluginId];
        if (this.plugin.getPluginMode(pluginId) === mode && (current?.mode === undefined || current.mode === mode)) return;
        // Changing the mode should preserve advanced lazy options so
        // users can temporarily disable a plugin without reconfiguring it.
        this.plugin.settings.plugins[pluginId] = {
            ...(this.plugin.settings.plugins[pluginId] ?? {}),
            mode,
            userConfigured: true,
        };
        this.tab.pendingPluginIds.add(pluginId);
        this.tab.markDirty();
        // Update only the badges in place so the row stays where it is even
        // when it no longer matches the active filter; re-filtering waits
        // until the user changes the filter conditions.
        setModeBadgeText(modeBadge, pluginModeLabel(mode));
        setEnabledBadgeState(enabledBadge, this.app, pluginId, this.savedCommunityPluginIds);
        this.refreshStats();
        this.tab.renderPendingControls(this.containerEl, () => this.display());
    }
    private refreshStats() {
        const statsEl = this.containerEl.querySelector(".lazy-plugin-statistics .setting-item-name");
        if (statsEl) statsEl.setText(pluginStatisticsText(this.plugin));
    }
    private async refreshCommunityPluginSnapshot() {
        const readId = ++this.communityPluginReadId;
        this.savedCommunityPluginIds = undefined;
        let parsed: unknown;
        try {
            parsed = await this.app.vault.readConfigJson("community-plugins");
        } catch {
            parsed = undefined;
        }
        if (readId !== this.communityPluginReadId) return;
        if (Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string")) {
            this.savedCommunityPluginIds = new Set(parsed);
        }
        this.updateVisibleEnabledBadges();
    }
    /**
     * Lazy loads (commands, views, files) and toggles from elsewhere happen
     * outside this page, so follow them while the page is shown to keep the
     * Enabled badges in sync without re-rendering the list.
     */
    private watchPluginLoadState() {
        this.unwatchPluginLoadState();
        // @ts-expect-error - Custom workspace event
        this.loadStateRef = this.app.workspace.on(PLUGIN_LOAD_STATE_CHANGED_EVENT, () => this.updateVisibleEnabledBadges());
    }
    private unwatchPluginLoadState() {
        if (!this.loadStateRef) return;
        this.app.workspace.offref(this.loadStateRef);
        this.loadStateRef = undefined;
    }
    private updateVisibleEnabledBadges() {
        this.containerEl.querySelectorAll<HTMLElement>(".lazy-plugin-enabled-badge").forEach((badge) => {
            const pluginId = badge.dataset.pluginId;
            if (!pluginId) return;
            setEnabledBadgeState(badge, this.app, pluginId, this.savedCommunityPluginIds);
        });
    }
    private disconnectInfiniteScroll() {
        this.infiniteScrollObserver?.disconnect();
        this.infiniteScrollObserver = undefined;
    }
}
