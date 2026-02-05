import { App, EventRef, WorkspaceLeaf } from "obsidian";
import { PluginMode } from "../settings";
import { isLeafVisible, rebuildLeafView, isPluginLoaded, PluginsMap } from "../utils/utils";

interface ViewLazyLoaderDeps {
    app: App;
    registerEvent: (eventRef: EventRef) => void;
    getPluginMode: (pluginId: string) => PluginMode;
    getLazyOnViews: () => Record<string, string[]> | undefined;
    ensurePluginLoaded: (pluginId: string) => Promise<boolean>;
    syncCommandWrappersForPlugin: (pluginId: string) => void;
}

export class ViewLazyLoader {
    constructor(private deps: ViewLazyLoaderDeps) {}

    registerActiveLeafReload(): void {
        this.deps.registerEvent(
            this.deps.app.workspace.on(
                "active-leaf-change",
                this.initializeLazyViewForLeaf.bind(this),
            ),
        );

        // Initial load
        this.deps.app.workspace.onLayoutReady(() =>
            this.deps.app.workspace.iterateAllLeaves((leaf) => {
                void this.initializeLazyViewForLeaf(leaf);
            }),
        );
    }

    async initializeLazyViewForLeaf(leaf: WorkspaceLeaf): Promise<void> {
        // Avoid loading lazy-on-view plugins during layout restoration.
        if (!this.deps.app.workspace.layoutReady) return;
        if (!leaf) return;
        if (!isLeafVisible(leaf)) return;

        const pluginId = this.getPluginIdForViewType(leaf.view.getViewType());
        if (!pluginId) return;

        if (this.deps.getPluginMode(pluginId) !== "lazyOnView") return;

        // If the plugin was already loaded, there's no need to rebuild the view
        const plugins = (this.deps.app as unknown as { plugins?: PluginsMap }).plugins;
        const wasLoaded = isPluginLoaded(plugins, pluginId);

        const loaded = await this.deps.ensurePluginLoaded(pluginId);
        if (!loaded) return;

        // Only reconstruct the view if the plugin was not already loaded before this call.
        if (!wasLoaded) {
            await rebuildLeafView(leaf);
            try {
            } catch (e) {
                // Keep behaviour consistent with other callers: don't throw on rebuild failure
                // (logging is handled elsewhere)
            }
        }

        this.deps.syncCommandWrappersForPlugin(pluginId);
    }

    async checkViewTypeForLazyLoading(viewType: string): Promise<void> {
        if (!viewType) return;
        if (!this.deps.app.workspace.layoutReady) return;

        const lazyOnViews = this.deps.getLazyOnViews() || {};
        for (const [pluginId, viewTypes] of Object.entries(lazyOnViews)) {
            if (viewTypes.includes(viewType)) {
                const mode = this.deps.getPluginMode(pluginId);
                if (mode === "lazyOnView") {
                    await this.deps.ensurePluginLoaded(pluginId);
                }
            }
        }
    }

    private getPluginIdForViewType(viewType: string): string | null {
        const lazyOnViews = this.deps.getLazyOnViews() || {};
        for (const [pluginId, viewTypes] of Object.entries(lazyOnViews)) {
            if (viewTypes.includes(viewType)) {
                return pluginId;
            }
        }
        return null;
    }
}
