import log from "loglevel";
import { WorkspaceLeaf } from "obsidian";
import { PluginLoader } from "../../core/interfaces";
import { PluginContext } from "../../core/plugin-context";
import { isPluginLoaded, rebuildLeafView } from "../../core/utils";
import { LockStrategy } from "./inernal/leaf-lock";

const logger = log.getLogger("OnDemandPlugin/BaseLazyLoader");

/**
 * Base class for lazy loaders that provides common functionality
 * for both view-based and file-based lazy loading.
 */
export abstract class BaseLazyLoader<TLockTarget> {
    constructor(
        protected ctx: PluginContext,
        protected pluginLoader: PluginLoader & {
            ensurePluginLoaded(pluginId: string): Promise<boolean>;
        },
        protected lockStrategy: LockStrategy<TLockTarget>,
    ) {}

    /**
     * Template method for lazy loading a plugin.
     * Subclasses should implement the specific resolution logic.
     * @returns true if the plugin was newly loaded, false if it was already loaded or failed to load
     */
    protected async loadPluginWithLock(
        lockTarget: TLockTarget,
        getPluginId: () => Promise<string | null>,
        context: { leafId: string; description: string },
        actionInsideLock?: (wasNewlyLoaded: boolean) => Promise<void>,
    ): Promise<boolean> {
        const release = await this.lockStrategy.lock(lockTarget);
        try {
            const wasNewlyLoaded = await this.loadPlugin(getPluginId, context);
            if (actionInsideLock) {
                await actionInsideLock(wasNewlyLoaded);
            }
            return wasNewlyLoaded;
        } finally {
            release.unlock();
        }
    }

    /**
     * Core plugin loading logic shared by all lazy loaders.
     * @returns true if the plugin was newly loaded, false if it was already loaded or failed to load
     */
    private async loadPlugin(
        getPluginId: () => Promise<string | null>,
        context: { leafId: string; description: string },
    ): Promise<boolean> {
        logger.debug(
            `started for ${context.description} in leaf ${context.leafId}`,
        );

        const pluginId = await getPluginId();
        if (!pluginId) {
            logger.debug(`no plugin resolved for ${context.description}`);
            return false;
        }

        const wasLoaded = isPluginLoaded(this.ctx.app, pluginId, false);
        logger.debug(`target plugin: ${pluginId}, wasLoaded: ${wasLoaded}`);

        if (wasLoaded) {
            logger.debug(`skipping ${pluginId} as it is already loaded`);
            return false;
        }

        logger.debug(`ensuring ${pluginId} is loaded...`);
        const loaded = await this.pluginLoader.ensurePluginLoaded(pluginId);
        logger.debug(`ensurePluginLoaded result for ${pluginId}: ${loaded}`);

        if (!loaded) {
            logger.debug(`plugin ${pluginId} failed to load`);
            return false;
        }

        return true;
    }

    /**
     * Rebuilds the view for a leaf and logs the result.
     */
    protected async rebuildLeafViewWithLogging(
        leaf: WorkspaceLeaf,
        leafId: string,
    ): Promise<void> {
        const oldViewType = leaf.view.getViewType();
        logger.debug(
            `triggering rebuildLeafView for leaf ${leafId}. Current viewType: ${oldViewType}`,
        );

        await rebuildLeafView(leaf);

        const newViewType = leaf.view.getViewType();
        logger.debug(
            `rebuildLeafView completed for leaf ${leafId}. New viewType: ${newViewType}`,
        );

        // Fallback: if view type didn't change and is still markdown, try forceful setViewState
        if (newViewType === oldViewType && oldViewType === "markdown") {
            logger.debug(
                `View type remains 'markdown'. Trying forceful setViewState fallback...`,
            );
            const state = leaf.getViewState();
            await leaf.setViewState(state);

            const finalViewType = leaf.view.getViewType();
            logger.debug(
                `after setViewState fallback, viewType is: ${finalViewType}`,
            );
        }
    }

    /**
     * Gets a unique identifier for a leaf.
     */
    protected getLeafId(leaf: WorkspaceLeaf): string {
        return leaf.id || "unknown";
    }
}
