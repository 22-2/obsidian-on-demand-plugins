import type { Commands } from "@obsidian-typings/obsidian-public-latest";
import { Mutex } from "async-mutex";
import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { ON_DEMAND_PLUGIN_ID } from "src/core/constants";
import type { EventBus } from "src/core/event-bus";
import type { AppFeature } from "src/core/feature";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import { ProgressDialog } from "src/core/progress";
import { saveLocalStorage } from "src/core/storage";
import { PLUGIN_MODE } from "src/core/types";
import { isLazyMode, isPluginLoaded } from "src/core/utils";
import type { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import { waitForPluginInitialization } from "src/patches/plugin-initialization";
import { capturePluginViews } from "src/patches/view-registry";
import type { CoreContainer } from "src/services/core-container";
import type { PluginRegistry } from "src/services/registry/plugin-registry";

const logger = log.getLogger("OnDemandPlugin/StartupPolicyFeature");
/** Bound concurrent initialization to avoid a load storm with hundreds of plugins. */
const REBUILD_CONCURRENCY = 3;

type StartupPolicyOptions = {
    pluginIds?: string[];
    externalProgress?: ProgressDialog | null;
    force?: boolean;
    /** Maintenance rebuild: report failures instead of restarting. */
    rebuilding?: boolean;
};

/**
 * Manages plugin startup policies and lifecycle.
 * Handles lazy loading, view-based loading, and persistent plugin states
 * with progress UI and cancellation support.
 */
export class StartupPolicyFeature implements AppFeature {
    private mutex = new Mutex();
    private events!: EventBus;
    private ctx!: PluginContext;
    private commandCacheService!: CommandCacheService;
    private registry!: PluginRegistry;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.ctx = ctx;
        this.events = events;
        const lazyEngine = features.get(LazyEngineFeature);
        this.commandCacheService = lazyEngine!.commandCache;
        this.registry = core.registry;
    }

    onunload() {}

    /** Apply startup policy reusing an externally created ProgressDialog. */
    public async applyWithProgress(progress: ProgressDialog | null, pluginIds?: string[]) {
        await this.mutex.runExclusive(() => this.executeStartupPolicy({ pluginIds, externalProgress: progress }));
    }

    public async rebuildWithProgress(progress: ProgressDialog | null, force = false) {
        await this.mutex.runExclusive(() => this.executeStartupPolicy({ externalProgress: progress, force, rebuilding: true }));
    }

    // -------------------------------------------------------------------------
    // Core execution
    // -------------------------------------------------------------------------

    private async executeStartupPolicy({ pluginIds, externalProgress, force = false, rebuilding = false }: StartupPolicyOptions) {
        const targetIds = pluginIds?.length ? new Set(pluginIds) : null;
        const allManifests = this.ctx.getManifests();
        const targetManifests = targetIds ? allManifests.filter((p) => targetIds.has(p.id)) : allManifests;
        // Commands and views share one load/unload cycle, including when applying a settings draft.
        const lazyManifests = targetManifests.filter((p) => this.needsRebuild(p.id, force));

        let cancelled = false;
        const progress = externalProgress
            ? (externalProgress.setOnCancel(() => {
                  cancelled = true;
              }),
              externalProgress.setTotal(lazyManifests.length),
              externalProgress)
            : this.openProgressDialog(
                  lazyManifests.length,
                  () => {
                      cancelled = true;
                  },
                  rebuilding,
              );

        // null means rebuilding stopped unexpectedly rather than with per-plugin failures.
        let failures: unknown[] | null = null;
        try {
            failures = await this.rebuildPlugins(lazyManifests, force, progress, () => cancelled);
        } finally {
            try {
                // Persist successful snapshots even if another plugin failed or the user cancelled.
                // Temporary unload hooks may skip unpersisted caches; restore their wrappers now.
                if (lazyManifests.length) this.commandCacheService.persistCache();
                this.commandCacheService.registerCachedCommands();
            } finally {
                // Applying settings must still restart: a plugin that keeps failing would otherwise
                // block every apply. Failed caches stay stale and are retried later.
                const shouldReload = failures !== null && !cancelled && (!rebuilding || failures.length === 0);
                await this.cleanupAndReload(shouldReload, progress);
            }
        }
        // A maintenance rebuild reports failures to the caller instead of restarting.
        if (rebuilding && failures?.length) throw new AggregateError(failures, "Failed to rebuild plugin caches");
    }

    // -------------------------------------------------------------------------
    // Plugin loading
    // -------------------------------------------------------------------------

    private needsRebuild(pluginId: string, force: boolean): boolean {
        if (!isLazyMode(this.ctx.getPluginMode(pluginId))) return false;
        if (force || !this.commandCacheService.isCommandCacheValid(pluginId)) return true;
        return this.usesViews(pluginId) && !this.hasCapturedViewTypes(pluginId);
    }

    private usesViews(pluginId: string): boolean {
        return this.ctx.getPluginMode(pluginId) === PLUGIN_MODE.LAZY && this.ctx.getSettings().plugins[pluginId]?.lazyOptions?.useView === true;
    }

    /** Rebuild each plugin's caches and return the per-plugin failures. */
    private async rebuildPlugins(manifests: PluginManifest[], force: boolean, progress: ProgressDialog, isCancelled: () => boolean): Promise<unknown[]> {
        let next = 0;
        let completed = 0;
        const errors: unknown[] = [];
        // View ownership comes from the plugin instance, not the global loadingPluginId.
        const worker = async () => {
            while (next < manifests.length && !isCancelled()) {
                const plugin = manifests[next++];
                progress.setStatus(`Rebuilding commands and views: ${plugin.name}`);
                try {
                    await this.rebuildPlugin(plugin.id, force);
                } catch (error) {
                    logger.warn("Failed to rebuild plugin caches", plugin.id, error);
                    errors.push(error);
                }
                progress.setProgress(++completed);
            }
        };
        await Promise.all(Array.from({ length: Math.min(REBUILD_CONCURRENCY, manifests.length) }, worker));
        return errors;
    }

    private async rebuildPlugin(pluginId: string, force: boolean) {
        const wasLoaded = isPluginLoaded(this.ctx.app, pluginId);
        const captureViews = this.usesViews(pluginId) && (force || !this.hasCapturedViewTypes(pluginId));
        const snapshot = async () => {
            // Re-run registrations when a running plugin needs a fresh view snapshot.
            if (captureViews && wasLoaded) await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            if (!isPluginLoaded(this.ctx.app, pluginId)) {
                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
            }
            await waitForPluginInitialization(this.ctx, pluginId);
            if (!isPluginLoaded(this.ctx.app, pluginId)) throw new Error(`Failed to load plugin ${pluginId}`);
            if (force || !this.commandCacheService.isCommandCacheValid(pluginId)) {
                await this.commandCacheService.snapshotCommandsForPlugin(pluginId);
            }
        };
        try {
            if (captureViews) await capturePluginViews(this.ctx, pluginId, snapshot);
            else await snapshot();
        } finally {
            await this.restoreLoadState(pluginId, wasLoaded);
        }
    }

    private async restoreLoadState(pluginId: string, wasLoaded: boolean) {
        const loaded = isPluginLoaded(this.ctx.app, pluginId);
        // A running plugin is reloaded for view capture; bring it back even if that reload failed.
        if (wasLoaded && !loaded) await this.ctx.obsidianPlugins.enablePlugin(pluginId);
        if (!wasLoaded && loaded) await this.ctx.obsidianPlugins.disablePlugin(pluginId);
    }

    private hasCapturedViewTypes(pluginId: string): boolean {
        const settings = this.ctx.getSettings();
        if (settings.plugins[pluginId]?.lazyOptions?.viewTypes?.length) return true;
        // An empty mapping also records a completed capture for plugins with no views.
        return Array.isArray(settings.lazyOnViews?.[pluginId]);
    }

    // -------------------------------------------------------------------------
    // Cleanup & persistence
    // -------------------------------------------------------------------------

    private async cleanupAndReload(shouldReload: boolean, progress: ProgressDialog | null) {
        try {
            const lazyOnViews = this.ctx.getSettings().lazyOnViews ?? {};
            await this.ctx.saveSettings();
            saveLocalStorage(this.ctx.app, "lazyOnViews", lazyOnViews);

            // Compute the desired enabled set (always-enabled + self)
            const desiredEnabled = new Set<string>(
                this.ctx
                    .getManifests()
                    .filter((p) => this.ctx.getPluginMode(p.id) === PLUGIN_MODE.ALWAYS_ENABLED)
                    .map((p) => p.id),
            );
            desiredEnabled.add(ON_DEMAND_PLUGIN_ID);

            // Update in-memory enabled set
            this.ctx.obsidianPlugins.enabledPlugins.clear();
            desiredEnabled.forEach((id) => this.ctx.obsidianPlugins.enabledPlugins.add(id));

            // Persist community-plugins file
            const toPersist = [...desiredEnabled].filter((id) => this.ctx.getPluginMode(id) === PLUGIN_MODE.ALWAYS_ENABLED || id === ON_DEMAND_PLUGIN_ID).sort((a, b) => a.localeCompare(b));

            await this.registry.writeCommunityPluginsFile(toPersist, this.ctx.getData().showConsoleLog);

            if (shouldReload) {
                try {
                    (this.ctx.app as unknown as { commands: Commands }).commands.executeCommandById("app:reload");
                } catch (error) {
                    logger.warn("Failed to reload app after apply", error);
                }
            }
        } finally {
            progress?.close();
        }
    }

    // -------------------------------------------------------------------------
    // UI helpers
    // -------------------------------------------------------------------------

    private openProgressDialog(total: number, onCancel: () => void, rebuilding: boolean): ProgressDialog {
        const dialog = new ProgressDialog(this.ctx.app, {
            title: rebuilding ? "Rebuilding command and view caches" : "Applying plugin startup policy",
            total: Math.max(1, total),
            cancellable: true,
            cancelText: "Cancel",
            onCancel,
        });
        dialog.open();
        return dialog;
    }
}
