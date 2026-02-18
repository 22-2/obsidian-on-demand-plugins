import { WorkspaceLeaf, debounce } from "obsidian";
import { PluginContext } from "../../core/plugin-context";
import { CommandRegistry, PluginLoader } from "../../core/interfaces";
import { isLeafVisible } from "../../core/utils";
import { LeafResource, LockStrategy } from "./inernal/leaf-lock";
import { resolvePluginForViewType } from "./inernal/activation-rules";
import { BaseLazyLoader } from "./base-lazy-loader";
import log from "loglevel";

const logger = log.getLogger("OnDemandPlugin/ViewLazyLoader");

/**
 * Handles lazy loading of plugins based on view types.
 * When a leaf with a specific view type becomes active, the corresponding
 * plugin is loaded and commands are synchronized.
 */
export class ViewLazyLoader extends BaseLazyLoader<LeafResource> {
    private debouncedInitializeLazyViewForLeaf = debounce(
        this.initializeLazyViewForLeaf.bind(this),
        100,
        true,
    );

    constructor(
        ctx: PluginContext,
        pluginLoader: PluginLoader & {
            ensurePluginLoaded(pluginId: string): Promise<boolean>;
        },
        private commandRegistry: CommandRegistry,
        lockStrategy: LockStrategy<LeafResource>,
    ) {
        super(ctx, pluginLoader, lockStrategy);
    }

    registerActiveLeafReload(): void {
        this.ctx.registerEvent(
            this.ctx.app.workspace.on(
                "active-leaf-change",
                this.debouncedInitializeLazyViewForLeaf,
            ),
        );

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

        logger.debug(
            `[LazyPlugins] initializeLazyViewForLeaf: started for leaf ${leafId}, viewType: ${viewType}`,
        );

        // Check visibility and re-entry guard before acquiring lock
        if (!isLeafVisible(leaf)) {
            logger.debug(
                `[LazyPlugins] initializeLazyViewForLeaf: skipped (not visible) for leaf ${leafId}`,
            );
            return;
        }

        await this.loadPluginWithLock(
            { leaf, viewType },
            async () => resolvePluginForViewType(this.ctx, viewType),
            { leafId, description: `viewType: ${viewType}` },
        );

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
