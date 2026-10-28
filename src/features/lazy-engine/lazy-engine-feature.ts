import log from "loglevel";
import type { WorkspaceLeaf } from "obsidian";
import { PLUGIN_LOAD_STATE_CHANGED_EVENT } from "src/core/constants";
import type { EventBus } from "src/core/event-bus";
import type { AppFeature } from "src/core/feature";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";
import { FileLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/file-lazy-loader";
import { LeafLockManager, LeafViewLockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";
import { ViewLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/view-lazy-loader";
import { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";
import { patchPluginEnableDisable } from "src/patches/plugin-enable-disable";
import { patchPluginLoad } from "src/patches/plugin-load";
import { patchPluginInitialization } from "src/patches/plugin-initialization";
import { patchRibbonReorder } from "src/patches/ribbon-reorder";
import { patchPluginRegisterView } from "src/patches/view-registry";
import { patchSetViewState } from "src/patches/view-state";
import type { CoreContainer } from "src/services/core-container";

const logger = log.getLogger("OnDemandPlugin/LazyEngineFeature");

export class LazyEngineFeature implements AppFeature {
    public commandCache!: CommandCacheService;
    public lazyRunner!: LazyCommandRunner;

    private viewLoader!: ViewLazyLoader;
    private fileLoader!: FileLazyLoader;
    private generation = 0;
    private active = false;
    private ctx!: PluginContext;
    private events!: EventBus;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.generation++;
        this.active = true;
        this.ctx = ctx;
        this.events = events;

        // 1. Core Engine parts
        // The cache only needs a way to run a wrapped command, so it takes a callback
        // and the runner can receive the finished cache in its constructor. Wrappers
        // fire only after onload returns, by which time lazyRunner is assigned.
        this.commandCache = new CommandCacheService(ctx, (commandId) => this.lazyRunner.runLazyCommand(commandId));
        this.lazyRunner = new LazyCommandRunner(ctx, this.commandCache);

        // 2. Loaders setup
        const lockManager = new LeafLockManager();
        this.viewLoader = new ViewLazyLoader(ctx, this.lazyRunner, this.commandCache, new LeafViewLockStrategy(lockManager));

        this.fileLoader = new FileLazyLoader(ctx, this.lazyRunner, { lock: (leaf: WorkspaceLeaf) => lockManager.lock(leaf, "leaf-generic") });

        // 3. Patches and Subscriptions
        patchPluginEnableDisable(ctx, {
            setPluginMode: (pluginId, mode) => this.setPluginMode(pluginId, mode),
            syncCommandWrappers: (pluginId) => this.commandCache.syncCommandWrappersForPlugin(pluginId),
        });
        ctx.register(patchPluginLoad(ctx.obsidianPlugins, (pluginId) => ctx.app.workspace.trigger(PLUGIN_LOAD_STATE_CHANGED_EVENT, pluginId)));
        ctx.register(patchPluginInitialization());
        patchSetViewState({
            register: (unload) => this.ctx.register(unload),
            onViewType: (viewType: string, leaf: WorkspaceLeaf) => this.viewLoader.checkViewTypeForLazyLoading(viewType, leaf),
        });
        patchRibbonReorder(ctx);
        // Session-wide: attribute registerView calls to their plugin even when
        // they happen after an await in onload (loadingPluginId is gone by then).
        ctx.register(patchPluginRegisterView(ctx));

        this.viewLoader.registerActiveLeafReload();
        this.fileLoader.register();

        // 4. Initialize cache BEFORE hooking onLayoutReady: when the plugin is
        // (re)loaded after the workspace is already ready, onLayoutReady fires the
        // callback synchronously, and the stale-cache refresh would then run against
        // an empty store and find nothing to rebuild.
        this.commandCache.loadFromData();
        this.commandCache.registerCachedCommands();

        this.registerLayoutReadyLoader();
    }

    onunload() {
        this.generation++;
        this.active = false;
        this.commandCache?.clear();
        this.lazyRunner?.clear();
    }

    private registerLayoutReadyLoader() {
        const generation = this.generation;
        this.ctx.app.workspace.onLayoutReady(() => {
            if (generation !== this.generation) return;
            void this.onLayoutReady();
        });
    }

    private async onLayoutReady() {
        if (!this.active) return;
        const generation = this.generation;
        await this.loadAfterLayoutReady(generation);
    }

    private async loadAfterLayoutReady(generation: number) {
        const manifests = this.ctx.getManifests();

        const toLoad = manifests.filter((m) => this.ctx.getPluginMode(m.id) === PLUGIN_MODE.LAZY_ON_LAYOUT_READY);

        if (toLoad.length > 0) {
            await this.runLayoutTasks(toLoad.map((manifest) => manifest.id), generation, async (id) => {
                await this.lazyRunner.ensurePluginLoaded(id).catch((err) => logger.error("Failed loading plugin onLayoutReady", id, err));
            });
            if (generation !== this.generation) return;
            this.commandCache.registerCachedCommands();
        }

        // Stale caches (built for an older plugin version) were skipped at startup to
        // avoid registering wrappers for command IDs that may no longer exist (issue #6).
        // Rebuild them here, after layout-ready plugins are loaded, so the wasEnabled
        // check inside refreshStaleCacheForPlugin sees the final enabled state.
        if (generation === this.generation) await this.refreshStaleCommandCaches(generation);
    }

    private async refreshStaleCommandCaches(generation: number) {
        const staleIds = this.commandCache.getStaleCachedPluginIds();
        if (staleIds.length === 0) return;

        await this.runLayoutTasks(staleIds, generation, async (id) => {
            await this.commandCache.refreshStaleCacheForPlugin(id).catch((err) => logger.error("Failed refreshing stale command cache", id, err));
        });
    }

    /** Stop taking new work after unload; already running plugin loads finish normally. */
    private async runLayoutTasks(ids: readonly string[], generation: number, task: (id: string) => Promise<void>): Promise<void> {
        let next = 0;
        const worker = async () => {
            while (generation === this.generation && next < ids.length) {
                await task(ids[next++]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    }

    /**
     * Save a user-chosen mode for a plugin, then apply it.
     */
    async setPluginMode(pluginId: string, mode: PLUGIN_MODE) {
        // Mode changes must not erase the plugin's advanced lazy rules; those
        // rules are independent of whether the plugin is currently enabled.
        await this.ctx.saveSettingsChange((data, profileId) => {
            const plugins = data.profiles[profileId].settings.plugins;
            plugins[pluginId] = { ...(plugins[pluginId] ?? {}), mode, userConfigured: true };
        });
        await this.applyPluginState(pluginId);
    }

    /**
     * Apply the state for a single plugin based on its mode.
     */
    async applyPluginState(pluginId: string) {
        const mode = this.ctx.getPluginMode(pluginId);
        if (mode === PLUGIN_MODE.ALWAYS_ENABLED) {
            if (!isPluginLoaded(this.ctx.app, pluginId)) {
                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
                await this.lazyRunner.waitForPluginLoaded(pluginId);
            }
            this.commandCache.removeCachedCommandsForPlugin(pluginId);
            return;
        }

        if (mode === PLUGIN_MODE.LAZY) {
            try {
                await this.commandCache.ensureCommandsCached(pluginId);
            } finally {
                // Caching commands may have just loaded the plugin, even if its initialization failed.
                // enablePlugin does not add it to enabledPlugins, so check the loaded state or it
                // would keep running this session.
                if (isPluginLoaded(this.ctx.app, pluginId)) {
                    await this.ctx.obsidianPlugins.disablePlugin(pluginId);
                }
                this.commandCache.registerCachedCommandsForPlugin(pluginId);
            }
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

        if (isPluginLoaded(this.ctx.app, pluginId)) {
            await this.ctx.obsidianPlugins.disablePlugin(pluginId);
        }
        this.commandCache.removeCachedCommandsForPlugin(pluginId);
    }
}
