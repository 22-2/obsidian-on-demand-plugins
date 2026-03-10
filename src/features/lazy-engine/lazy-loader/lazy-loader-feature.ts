import type { WorkspaceLeaf } from "obsidian";
import type { AppFeature } from "../../../core/feature";
import type { PluginContext } from "../../core/plugin-context";
import { patchSetViewState } from "../../../patches/view-state";
import type { CoreContainer } from "../../../services/core-container";
import { FileLazyLoader } from "./loaders/file-lazy-loader";
import { LeafLockManager, LeafViewLockStrategy } from "./loaders/internal/leaf-lock";
import { ViewLazyLoader } from "./loaders/view-lazy-loader";

export class LazyLoaderFeature implements AppFeature {
    viewLoader!: ViewLazyLoader;
    fileLoader!: FileLazyLoader;
    private ctx!: PluginContext;

    onload(ctx: PluginContext, core: CoreContainer) {
        this.ctx = ctx;

        // Unified lock manager for memory-safe leaf locking
        const lockManager = new LeafLockManager();

        this.viewLoader = new ViewLazyLoader(
            ctx,
            core.lazyRunner,
            core.commandCache,
            new LeafViewLockStrategy(lockManager)
        );

        this.fileLoader = new FileLazyLoader(
            ctx,
            core.lazyRunner,
            // Delegate to the shared manager with the "leaf-generic" subKey
            {
                lock: (leaf: WorkspaceLeaf) => lockManager.lock(leaf, "leaf-generic"),
            },
        );

        patchSetViewState({
            register: this.ctx.register.bind(this.ctx),
            onViewType: (viewType: string) => this.viewLoader.checkViewTypeForLazyLoading(viewType),
        });

        this.viewLoader.registerActiveLeafReload();

        // Register standardized FileLazyLoader (handles Excalidraw and others via lazyOnFiles)
        this.fileLoader.register();
    }

    onunload() {
        // teardown is handled by ctx.register within loaders/patches
    }
}
