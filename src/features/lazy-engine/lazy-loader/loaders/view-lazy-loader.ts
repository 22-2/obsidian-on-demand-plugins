import log from "loglevel";
import type { WorkspaceLeaf } from "obsidian";
import { debounce } from "obsidian";
import type { CommandRegistry, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLeafVisible, isPluginLoaded } from "src/core/utils";
import { BaseLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/base-lazy-loader";
import { resolvePluginForViewType } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import type { LeafResource, LockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";
import { getPluginDisplayName, showLeafLoading } from "src/ui/load-feedback";

const logger = log.getLogger("OnDemandPlugin/ViewLazyLoader");

/**
 * Handles lazy loading of plugins based on view types.
 * When a leaf with a specific view type becomes active, the corresponding
 * plugin is loaded and commands are synchronized.
 */
export class ViewLazyLoader extends BaseLazyLoader<LeafResource> {
    private debouncedInitializeLazyViewForLeaf = debounce(
        (leaf: WorkspaceLeaf | null) => {
            if (leaf) {
                void this.initializeLazyViewForLeaf(leaf);
            }
        },
        100,
        true,
    );

    // Expanding a collapsed sidebar makes its leaves visible without an active-leaf-change,
    // and Obsidian only reports it as a workspace "resize". Dragging a divider fires many of
    // those, so rescan once the burst settles.
    private debouncedInitializeVisibleLazyLeaves = debounce(() => this.initializeVisibleLazyLeaves(), 100, true);

    private commandRegistry: CommandRegistry;

    constructor(
        ctx: PluginContext,
        pluginLoader: PluginLoader & {
            ensurePluginLoaded(pluginId: string): Promise<boolean>;
        },
        commandRegistry: CommandRegistry,
        lockStrategy: LockStrategy<LeafResource>,
    ) {
        super(ctx, pluginLoader, lockStrategy);
        this.commandRegistry = commandRegistry;
    }

    registerActiveLeafReload(): void {
        this.ctx.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.debouncedInitializeLazyViewForLeaf));
        this.ctx.registerEvent(this.ctx.app.workspace.on("resize", this.debouncedInitializeVisibleLazyLeaves));

        // Initial load
        this.ctx.app.workspace.onLayoutReady(() =>
            this.ctx.app.workspace.iterateAllLeaves((leaf) => {
                void this.initializeLazyViewForLeaf(leaf);
            }),
        );
    }

    /**
     * Load the plugins behind visible leaves whose view type belongs to a lazy plugin that is not loaded yet.
     * A leaf restored while its sidebar was collapsed keeps the view type as a placeholder, and Obsidian
     * swaps in the real view once the plugin registers it.
     */
    initializeVisibleLazyLeaves(): void {
        if (!this.ctx.app.workspace.layoutReady) return;

        this.ctx.app.workspace.iterateAllLeaves((leaf) => {
            // Filter before initializeLazyViewForLeaf so a resize does not take a lock on every leaf.
            if (!isLeafVisible(leaf)) return;
            const pluginId = resolvePluginForViewType(this.ctx, leaf.view.getViewType());
            if (!pluginId || isPluginLoaded(this.ctx.app, pluginId)) return;
            void this.initializeLazyViewForLeaf(leaf);
        });
    }

    async initializeLazyViewForLeaf(leaf: WorkspaceLeaf): Promise<void> {
        if (!this.ctx.app.workspace.layoutReady) return;
        if (!leaf) return;

        const viewType = leaf.view.getViewType();
        const leafId = this.getLeafId(leaf);

        logger.debug(`[LazyPlugins] initializeLazyViewForLeaf: started for leaf ${leafId}, viewType: ${viewType}`);

        // Check visibility and re-entry guard before acquiring lock
        if (!isLeafVisible(leaf)) {
            logger.debug(`[LazyPlugins] initializeLazyViewForLeaf: skipped (not visible) for leaf ${leafId}`);
            return;
        }

        const pluginId = resolvePluginForViewType(this.ctx, viewType);
        const hideLoading = this.showLoadingWhilePending(leaf, pluginId);
        try {
            await this.loadPluginWithLock({ leaf, viewType }, () => Promise.resolve(pluginId), { leafId, description: `viewType: ${viewType}` });
        } finally {
            hideLoading();
        }

        // Sync commands and update re-entry guard
        if (pluginId) {
            this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
        }
    }

    async checkViewTypeForLazyLoading(viewType: string, leaf?: WorkspaceLeaf): Promise<void> {
        if (!viewType) return;
        if (!this.ctx.app.workspace.layoutReady) return;

        const pluginId = resolvePluginForViewType(this.ctx, viewType);
        if (!pluginId) return;

        // The leaf keeps the placeholder only while the requested type is still unregistered.
        const hideLoading = leaf?.view?.getViewType() === viewType ? this.showLoadingWhilePending(leaf, pluginId) : () => {};
        try {
            await this.pluginLoader.ensurePluginLoaded(pluginId);
        } finally {
            hideLoading();
        }
    }

    /** Show a spinner on the leaf until its plugin loads, so the empty placeholder does not look broken. */
    private showLoadingWhilePending(leaf: WorkspaceLeaf, pluginId: string | null): () => void {
        if (!pluginId || isPluginLoaded(this.ctx.app, pluginId)) return () => {};
        return showLeafLoading(leaf, getPluginDisplayName(this.ctx, pluginId));
    }
}
