import log from "loglevel";
import type { WorkspaceLeaf } from "obsidian";
import { debounce } from "obsidian";
import type { CommandRegistry, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLeafVisible } from "src/core/utils";
import { BaseLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/base-lazy-loader";
import { resolvePluginForViewType } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import type { LeafResource, LockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";

const logger = log.getLogger("OnDemandPlugin/ViewLazyLoader");

/**
 * Handles lazy loading of plugins based on view types.
 * When a leaf with a specific view type becomes active, the corresponding
 * plugin is loaded and commands are synchronized.
 */
export class ViewLazyLoader extends BaseLazyLoader<LeafResource> {
    private debouncedInitializeLazyViewForLeaf = debounce(
        (leaf: WorkspaceLeaf) => {
            void this.initializeLazyViewForLeaf(leaf);
        },
        100,
        true,
    );

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
        this.ctx.registerEvent(this.ctx.app.workspace.on("active-leaf-change" as unknown, this.debouncedInitializeLazyViewForLeaf as unknown));

        // Initial load
        this.ctx.app.workspace.onLayoutReady(() =>
            this.ctx.app.workspace.iterateAllLeaves((leaf) => {
                void this.initializeLazyViewForLeaf(leaf);
            }),
        );
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

        await this.loadPluginWithLock({ leaf, viewType }, () => Promise.resolve(resolvePluginForViewType(this.ctx, viewType)), { leafId, description: `viewType: ${viewType}` });

        // Sync commands and update re-entry guard
        const pluginId = resolvePluginForViewType(this.ctx, viewType);
        if (pluginId) {
            this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
        }
    }

    async checkViewTypeForLazyLoading(viewType: string): Promise<void> {
        if (!viewType) return;
        if (!this.ctx.app.workspace.layoutReady) return;

        const pluginId = resolvePluginForViewType(this.ctx, viewType);
        if (pluginId) {
            await this.pluginLoader.ensurePluginLoaded(pluginId);
        }
    }
}
