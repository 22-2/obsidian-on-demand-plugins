/**
 * ServiceContainer — Composition Root
 *
 * Creates and wires all services together. This is the single place
 * where the object graph is assembled, replacing the ad-hoc callback
 * wiring that was previously spread across main.ts.
 */
import { PluginManifest } from "obsidian";
import { PluginContext } from "./plugin-context";
import { CommandCacheService } from "../features/command-cache/command-cache-service";
import { LazyCommandRunner } from "../features/lazy-runner/lazy-command-runner";
import { PluginRegistry } from "../features/registry/plugin-registry";
import { SettingsService } from "../features/settings/settings-service";
import { StartupPolicyService } from "../features/startup-policy/startup-policy-service";
import { ViewLazyLoader } from "../features/view-loader/view-lazy-loader";
import { FileLazyLoader } from "../features/view-loader/file-lazy-loader";
import { patchPluginEnableDisable } from "../patches/plugin-enable-disable";
import { patchSetViewState } from "../patches/view-state";

export class ServiceContainer {
    readonly registry: PluginRegistry;
    readonly settingsService: SettingsService;
    readonly lazyRunner: LazyCommandRunner;
    readonly commandCache: CommandCacheService;
    readonly startupPolicy: StartupPolicyService;
    readonly viewLoader: ViewLazyLoader;
    readonly fileLoader: FileLazyLoader;

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

        // 7. ViewLazyLoader (needs ctx + pluginLoader + commandRegistry)
        this.viewLoader = new ViewLazyLoader(
            ctx,
            this.lazyRunner,
            this.commandCache,
        );

        // 8. FileLazyLoader (needs ctx + pluginLoader)
        this.fileLoader = new FileLazyLoader(ctx, this.lazyRunner);
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
    }

    /**
     * Rebuild the command cache for all lazy plugins and apply startup policy.
     */
    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        const force = options?.force ?? false;
        await this.commandCache.refreshCommandCache(undefined, force);
        await this.startupPolicy.apply();
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
        await this.startupPolicy.apply(pluginIds);
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

        if (mode === "lazy" || mode === "lazyOnView") {
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
    }
}
