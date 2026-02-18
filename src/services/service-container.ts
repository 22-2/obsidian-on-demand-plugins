/**
 * ServiceContainer — Composition Root
 *
 * Creates and wires all services together. This is the single place
 * where the object graph is assembled, replacing the ad-hoc callback
 * wiring that was previously spread across main.ts.
 */
import { PluginManifest, WorkspaceLeaf } from "obsidian";
import PQueue from "p-queue";
import { ProgressDialog } from "../core/progress";
import { isLazyMode } from "../core/utils";
import { PluginContext } from "../core/plugin-context";
import { CommandCacheService } from "./command-cache/command-cache-service";
import { LazyCommandRunner } from "./lazy-runner/lazy-command-runner";
import { PluginRegistry } from "./registry/plugin-registry";
import { SettingsService } from "./settings/settings-service";
import { StartupPolicyService } from "./startup-policy/startup-policy-service";
import { ViewLazyLoader } from "./lazy-loader/view-lazy-loader";
import { FileLazyLoader } from "./lazy-loader/file-lazy-loader";
import { patchPluginEnableDisable } from "./patches/plugin-enable-disable";
import { patchSetViewState } from "./patches/view-state";
import {
    LeafLockManager,
    LeafViewLockStrategy,
} from "./lazy-loader/inernal/leaf-lock";

export class ServiceContainer {
    readonly registry: PluginRegistry;
    readonly settingsService: SettingsService;
    readonly lazyRunner: LazyCommandRunner;
    readonly commandCache: CommandCacheService;
    readonly startupPolicy: StartupPolicyService;
    readonly viewLoader: ViewLazyLoader;
    readonly fileLoader: FileLazyLoader;
    private layoutReadyQueue: PQueue;

    constructor(private ctx: PluginContext) {
        // 1. Registry (no service deps)
        this.registry = new PluginRegistry(ctx.app, ctx.obsidianPlugins);

        // 2. Settings (no service deps)
        this.settingsService = new SettingsService(
            // SettingsService expects a Plugin, we pass it through the context adapter
            ctx._plugin,
        );

        // 3. LazyCommandRunner (needs PluginContext only at construction)
        this.lazyRunner = new LazyCommandRunner(ctx);

        // 4. CommandCacheService (needs PluginContext + PluginLoader interface)
        this.commandCache = new CommandCacheService(ctx, this.lazyRunner);

        // 5. Wire LazyCommandRunner → CommandRegistry (setter injection to break cycle)
        this.lazyRunner.setCommandRegistry(this.commandCache);

        // 6. StartupPolicyService (needs ctx + commandCache + registry)
        this.startupPolicy = new StartupPolicyService(
            ctx,
            this.commandCache,
            this.registry,
        );

        // --- View & File Loading Support ---

        // Unified lock manager for memory-safe leaf locking
        const lockManager = new LeafLockManager();

        // 7. ViewLazyLoader (needs ctx + pluginLoader + commandRegistry)
        this.viewLoader = new ViewLazyLoader(
            ctx,
            this.lazyRunner,
            this.commandCache,
            new LeafViewLockStrategy(lockManager),
        );

        // 8. FileLazyLoader (needs ctx + pluginLoader)
        this.fileLoader = new FileLazyLoader(
            ctx,
            this.lazyRunner,
            // Delegate to the shared manager with the "leaf-generic" subKey
            {
                lock: (leaf: WorkspaceLeaf) =>
                    lockManager.lock(leaf, "leaf-generic"),
            },
        );

        // Queue used to limit concurrency when loading plugins on layout ready
        this.layoutReadyQueue = new PQueue({ concurrency: 3, interval: 100 });
    }

    /**
     * Perform all initialization that was previously in OnDemandPlugin.onload().
     * Assumes settings and registry manifests have already been loaded.
     */
    async initialize() {
        // Load enabled-plugins list from disk
        await this.registry.loadEnabledPluginsFromDisk(
            this.settingsService.data.showConsoleLog,
        );

        // Load command cache from persisted data
        this.commandCache.loadFromData();
        this.commandCache.registerCachedCommands();

        // Apply monkey-patches
        patchPluginEnableDisable(this.ctx, this.commandCache);

        patchSetViewState({
            register: this.ctx.register.bind(this.ctx),
            onViewType: (viewType: string) =>
                this.viewLoader.checkViewTypeForLazyLoading(viewType),
        });

        this.viewLoader.registerActiveLeafReload();

        // Register standardized FileLazyLoader (handles Excalidraw and others via lazyOnFiles)
        this.fileLoader.register();

        this.registerLayoutReadyLoader();
    }

    private registerLayoutReadyLoader() {
        this.ctx.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
    }

    private async onLayoutReady() {
        const manifests = this.ctx.getManifests();

        const toLoad = manifests.filter(
            (m) => this.ctx.getPluginMode(m.id) === "lazyOnLayoutReady",
        );

        if (toLoad.length === 0) return;

        const tasks = toLoad.map((manifest) =>
            this.layoutReadyQueue.add(() =>
                this.lazyRunner.ensurePluginLoaded(manifest.id).catch((err) =>
                    console.error(
                        "Failed loading plugin onLayoutReady",
                        manifest.id,
                        err,
                    ),
                ),
            ),
        );

        await Promise.all(tasks);
    }

    /**
     * Rebuild the command cache for all lazy plugins and apply startup policy.
     */
    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        const force = options?.force ?? false;
        // Show a progress dialog early to cover the command cache rebuild and the
        // subsequent startup policy apply steps.
        const manifests = this.ctx.getManifests();
        const lazyCount = manifests.filter(
            (p) => this.ctx.getPluginMode(p.id) === "lazyOnView",
        ).length;

        const progress = new ProgressDialog(this.ctx.app, {
            title: "Rebuilding command cache",
            total: Math.max(1, lazyCount) + 2,
            cancellable: true,
            cancelText: "Cancel",
            onCancel: () => {},
        });
        progress.open();

        await this.commandCache.refreshCommandCache(
            undefined,
            force,
            (current, total, plugin) => {
                progress.setStatus(`Rebuilding ${plugin.name}`);
                progress.setProgress(current, total);
            },
        );

        // Reuse the same progress dialog for the startup policy apply step so
        // the user sees a continuous progress experience.
        await this.startupPolicy.applyWithProgress(progress);
        this.commandCache.registerCachedCommands();
    }

    /**
     * Rebuild command cache for specific plugins.
     */
    async rebuildCommandCache(
        pluginIds: string[],
        options?: {
            force?: boolean;
            onProgress?: (
                current: number,
                total: number,
                plugin: PluginManifest,
            ) => void;
        },
    ) {
        const force = options?.force ?? false;
        await this.commandCache.refreshCommandCache(
            pluginIds,
            force,
            options?.onProgress,
        );
        this.commandCache.registerCachedCommands();
    }

    /**
     * Apply startup policy to specified plugins or all plugins.
     */
    async applyStartupPolicy(pluginIds?: string[]) {
        await this.startupPolicy.applyWithProgress(null, pluginIds);
    }

    /**
     * Apply the state for a single plugin based on its mode.
     */
    async applyPluginState(pluginId: string) {
        const mode = this.ctx.getPluginMode(pluginId);
        if (mode === "keepEnabled") {
            if (!this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
                await this.lazyRunner.waitForPluginLoaded(pluginId);
            }
            this.commandCache.removeCachedCommandsForPlugin(pluginId);
            return;
        }

        if (isLazyMode(mode)) {
            await this.commandCache.ensureCommandsCached(pluginId);
            if (this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
                await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            }
            this.commandCache.registerCachedCommandsForPlugin(pluginId);
            return;
        }

        if (this.ctx.obsidianPlugins.enabledPlugins.has(pluginId)) {
            await this.ctx.obsidianPlugins.disablePlugin(pluginId);
        }
        this.commandCache.removeCachedCommandsForPlugin(pluginId);
    }

    destroy() {
        this.commandCache?.clear();
        this.lazyRunner?.clear();
        this.registry?.clear();
        this.layoutReadyQueue?.clear();
    }
}
