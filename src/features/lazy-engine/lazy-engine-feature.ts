import type { WorkspaceLeaf } from "obsidian";
import type { EventBus } from "src/core/event-bus";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";
import { FileLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/file-lazy-loader";
import { LeafLockManager, LeafViewLockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";
import { ViewLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/view-lazy-loader";
import { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";
import PQueue from "p-queue";
import { PLUGIN_MODE } from "src/core/types";
import type { AppFeature } from "src/core/feature";
import { patchSetViewState } from "src/patches/view-state";
import type { CoreContainer } from "src/services/core-container";

export class LazyEngineFeature implements AppFeature {
    public commandCache!: CommandCacheService;
    public lazyRunner!: LazyCommandRunner;
    
    private viewLoader!: ViewLazyLoader;
    private fileLoader!: FileLazyLoader;
    private layoutReadyQueue!: PQueue;
    private ctx!: PluginContext;
    private events!: EventBus;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.ctx = ctx;
        this.events = events;

        // 1. Core Engine parts
        this.lazyRunner = new LazyCommandRunner(ctx);
        this.commandCache = new CommandCacheService(ctx, this.lazyRunner);
        
        // Wire up setter injection 
        this.lazyRunner.setCommandRegistry(this.commandCache);

        // 2. Loaders setup
        const lockManager = new LeafLockManager();
        this.viewLoader = new ViewLazyLoader(
            ctx,
            this.lazyRunner,
            this.commandCache,
            new LeafViewLockStrategy(lockManager)
        );

        this.fileLoader = new FileLazyLoader(
            ctx,
            this.lazyRunner,
            { lock: (leaf: WorkspaceLeaf) => lockManager.lock(leaf, "leaf-generic") }
        );

        // 3. Patches and Subscriptions
        patchSetViewState({
            register: this.ctx.register.bind(this.ctx),
            onViewType: (viewType: string) => this.viewLoader.checkViewTypeForLazyLoading(viewType),
        });

        this.viewLoader.registerActiveLeafReload();
        this.fileLoader.register();

        this.layoutReadyQueue = new PQueue({ concurrency: 3, interval: 100 });
        this.registerLayoutReadyLoader();

        // 4. Initialize cache
        this.commandCache.loadFromData();
        this.commandCache.registerCachedCommands();
    }

    onunload() {
        this.commandCache?.clear();
        this.lazyRunner?.clear();
        this.layoutReadyQueue?.clear();
    }

    private registerLayoutReadyLoader() {
        this.ctx.app.workspace.onLayoutReady(() => {
            void this.onLayoutReady();
        });
    }

    private async onLayoutReady() {
        const manifests = this.ctx.getManifests();

        const toLoad = manifests.filter((m) => this.ctx.getPluginMode(m.id) === PLUGIN_MODE.LAZY_ON_LAYOUT_READY);

        if (toLoad.length === 0) return;

        const tasks = toLoad.map((manifest) =>
            this.layoutReadyQueue.add(() =>
                this.lazyRunner.ensurePluginLoaded(manifest.id).catch((err) =>
                    console.error("Failed loading plugin onLayoutReady", manifest.id, err)
                )
            )
        );

        await Promise.all(tasks);
        this.commandCache.registerCachedCommands();
    }

    /**
     * Apply the state for a single plugin based on its mode.
     */
    async applyPluginState(pluginId: string) {
        const mode = this.ctx.getPluginMode(pluginId);
        if (mode === PLUGIN_MODE.ALWAYS_ENABLED) {
            if (!this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
                await this.lazyRunner.waitForPluginLoaded(pluginId);
            }
            this.commandCache.removeCachedCommandsForPlugin(pluginId);
            return;
        }

        if (mode === PLUGIN_MODE.LAZY) {
            await this.commandCache.ensureCommandsCached(pluginId);
            if (this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            }
            this.commandCache.registerCachedCommandsForPlugin(pluginId);
            return;
        }

        if (mode === PLUGIN_MODE.LAZY_ON_LAYOUT_READY) {
            this.commandCache.removeCachedCommandsForPlugin(pluginId);
            // If layout is already ready, load it immediately. Otherwise it will be handled by the layoutReadyLoader.
            if (this.ctx.app.workspace.layoutReady) {
                await this.lazyRunner.ensurePluginLoaded(pluginId);
            }
            return;
        }

        if (this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
            await this.ctx.obsidianPlugins.disablePlugin(pluginId);
        }
        this.commandCache.removeCachedCommandsForPlugin(pluginId);
    }
}
