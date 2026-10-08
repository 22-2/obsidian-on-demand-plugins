import type { App } from "obsidian";
import { ExtraButtonComponent, Menu, Setting, SettingPage } from "obsidian";
import { PLUGIN_MODE } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import type OnDemandPlugin from "src/main";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";
import { addPluginRowMenuItems } from "src/ui/plugin-row-menu";
import { showInCommunityPlugins } from "src/ui/show-in-community-plugins";
import type { SettingsTab } from "src/ui/settings-tab";
import { addModeOptions, enabledBadgeText, getPluginStatistics, openPluginDirectory, pluginModeLabel, pluginStatisticsText } from "src/ui/settings/helpers";

export class PluginPage extends SettingPage {
    private static readonly PAGE_SIZE = 24;
    private filter = "";
    private mode?: PLUGIN_MODE;
    private app: App;
    private plugin: OnDemandPlugin;
    private tab: SettingsTab;
    private infiniteScrollObserver?: IntersectionObserver;
    private loadedCount = 0;
    private savedCommunityPluginIds?: Set<string>;
    private communityPluginReadId = 0;
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
        void this.refreshCommunityPluginSnapshot();
        this.containerEl.empty();
        this.tab.renderPendingControls(this.containerEl, () => this.display());
        new Setting(this.containerEl).setName("Statistics").setHeading();
        new Setting(this.containerEl)
            .setName(pluginStatisticsText(this.plugin))
            .setDesc(`${getPluginStatistics(this.plugin).total} plugins total · disabled / on demand / on layout ready / enabled`)
            .setClass("lazy-plugin-statistics");
        new Setting(this.containerEl)
            .setName("Plugins")
            .setHeading()
            .addExtraButton((button) =>
                button
                    .setIcon("refresh-cw")
                    .setTooltip("Refresh plugin list")
                    .onClick(() => {
                        this.plugin.updateManifests();
                        void this.refreshCommunityPluginSnapshot();
                        // Re-render the list directly: tab.update() does not
                        // guarantee the open page is re-displayed, so relying
                        // on it leaves live badges (e.g. Enabled after an
                        // on-demand load) stale.
                        this.renderInfiniteList();
                    }),
            );
        const filterSetting = new Setting(this.containerEl).setName("Filter");
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
            });
        this.containerEl.createDiv({ cls: "lazy-plugin-infinite-host" });
        this.renderInfiniteList();
    }
    hide() {
        this.disconnectInfiniteScroll();
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
            setting.setClass("lazy-plugin-mode-row");
            // Give variable-length descriptions their own line so metadata
            // always starts at a predictable position within each row.
            setting.descEl.createDiv({ cls: "lazy-plugin-description", text: manifest.description });
            // The current mode lives in passive badges so the row never owns
            // an editable control; edits go through the 3-dot menu instead.
            const badges = setting.descEl.createDiv({ cls: "lazy-plugin-badges" });
            const mode = this.plugin.getPluginMode(manifest.id);
            const modeBadge = badges.createSpan({
                cls: "lazy-plugin-mode-badge",
                text: pluginModeLabel(mode),
            });
            // Show the live runtime state; the staged mode alone cannot tell
            // whether a lazy plugin is actually loaded right now.
            const enabledBadge = badges.createSpan({
                cls: "lazy-plugin-enabled-badge",
                text: enabledBadgeText(this.app, manifest.id, this.savedCommunityPluginIds),
            });
            enabledBadge.setAttr("data-plugin-id", manifest.id);
            enabledBadge.toggleClass("is-loaded", isPluginLoaded(this.app, manifest.id));
            // Author names vary widely in length; keep them on a separate
            // line and omit the attribution prefix when no author is given.
            const author = manifest.author?.trim();
            setting.descEl.createDiv({
                cls: "lazy-plugin-meta-badge",
                text: `v${manifest.version}${author ? ` · by ${author}` : ""}`,
            });
            const actionsButton = new ExtraButtonComponent(setting.controlEl).setIcon("ellipsis-vertical").setTooltip("Plugin actions");
            actionsButton.extraSettingsEl.addClass("lazy-plugin-row-actions-desktop");
            // Both controls open the same menu; anchor it to the visible control
            // because ExtraButtonComponent callbacks do not provide a MouseEvent.
            const openActions = (anchor: HTMLElement) => {
                const menu = new Menu();
                addPluginRowMenuItems(menu, {
                    getMode: () => this.plugin.getPluginMode(manifest.id),
                    onOpenDetails: () =>
                        new LazyOptionsModal(this.app, this.plugin, manifest.id, () => {
                            this.tab.pendingPluginIds.add(manifest.id);
                            this.tab.markDirty();
                            this.tab.renderPendingControls(this.containerEl, () => this.display());
                        }).open(),
                    onShowInCommunityPlugins: () => showInCommunityPlugins(this.app, manifest.id),
                    onRevealInExplorer: () => void openPluginDirectory(this.app, manifest),
                    onToggleEnabled: (enabled) => this.applyRowModeChange(manifest.id, enabled ? PLUGIN_MODE.ALWAYS_ENABLED : PLUGIN_MODE.ALWAYS_DISABLED, modeBadge, enabledBadge),
                    onSelectMode: (mode) => this.applyRowModeChange(manifest.id, mode, modeBadge, enabledBadge),
                });
                const rect = anchor.getBoundingClientRect();
                // Settings can live in a separate window; use its document so the
                // menu and anchor coordinates refer to the same visible surface.
                menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.ownerDocument);
            };
            actionsButton.onClick(() => openActions(actionsButton.extraSettingsEl));
            // A labeled native button makes the mobile action easier to discover
            // and press while sharing the desktop menu's behavior.
            setting.addButton((button) => {
                button.setIcon("ellipsis-vertical").onClick(() => openActions(button.buttonEl));
                // setIcon replaces button contents, so append the label afterward.
                button.buttonEl.createSpan({ text: "Actions" });
                button.buttonEl.addClass("lazy-plugin-row-actions-mobile");
            });
        });
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
        modeBadge.setText(pluginModeLabel(mode));
        enabledBadge.setText(enabledBadgeText(this.app, pluginId, this.savedCommunityPluginIds));
        enabledBadge.toggleClass("is-loaded", isPluginLoaded(this.app, pluginId));
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
    private updateVisibleEnabledBadges() {
        this.containerEl.querySelectorAll<HTMLElement>(".lazy-plugin-enabled-badge").forEach((badge) => {
            const pluginId = badge.dataset.pluginId;
            if (!pluginId) return;
            const loaded = isPluginLoaded(this.app, pluginId);
            badge.setText(enabledBadgeText(this.app, pluginId, this.savedCommunityPluginIds));
            badge.toggleClass("is-loaded", loaded);
        });
    }
    private disconnectInfiniteScroll() {
        this.infiniteScrollObserver?.disconnect();
        this.infiniteScrollObserver = undefined;
    }
}
