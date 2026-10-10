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
        await this.mutex.runExclusive(() => this.executeStartupPolicy(pluginIds, progress));
    }

    public async rebuildWithProgress(progress: ProgressDialog | null, force = false) {
        await this.mutex.runExclusive(() => this.executeStartupPolicy(undefined, progress, force, true));
    }

    // -------------------------------------------------------------------------
    // Core execution
    // -------------------------------------------------------------------------

    private async executeStartupPolicy(pluginIds?: string[], externalProgress?: ProgressDialog | null, force = false, rebuilding = false) {
        const targetIds = pluginIds?.length ? new Set(pluginIds) : null;
        const allManifests = this.ctx.getManifests();
        const targetManifests = targetIds ? allManifests.filter((p) => targetIds.has(p.id)) : allManifests;
        // Commands and views share one load/unload cycle, including when applying a settings draft.
        const lazyManifests = targetManifests.filter((p) => isLazyMode(this.ctx.getPluginMode(p.id)) && (force || !this.commandCacheService.isCommandCacheValid(p.id) || (this.usesViews(p.id) && !this.hasCapturedViewTypes(p.id))));

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

        let succeeded = false;
        try {
            await this.rebuildPlugins(lazyManifests, force, progress, () => cancelled);
            succeeded = true;
        } finally {
            try {
                // Persist successful snapshots even if another plugin failed or the user cancelled.
                // Temporary unload hooks may skip unpersisted caches; restore their wrappers now.
                if (lazyManifests.length) this.commandCacheService.persistCache();
                this.commandCacheService.registerCachedCommands();
            } finally {
                await this.cleanupAndReload(succeeded && !cancelled, progress);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Plugin loading
    // -------------------------------------------------------------------------

    private usesViews(pluginId: string): boolean {
        return this.ctx.getPluginMode(pluginId) === PLUGIN_MODE.LAZY && this.ctx.getSettings().plugins[pluginId]?.lazyOptions?.useView === true;
    }

    private async rebuildPlugins(manifests: PluginManifest[], force: boolean, progress: ProgressDialog, isCancelled: () => boolean) {
        let next = 0;
        let completed = 0;
        const errors: unknown[] = [];
        // Bound concurrent initialization to avoid a load storm with hundreds of plugins.
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
        await Promise.all(Array.from({ length: Math.min(3, manifests.length) }, worker));
        if (errors.length) throw new AggregateError(errors, "Failed to rebuild plugin caches");
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
            if (!wasLoaded && isPluginLoaded(this.ctx.app, pluginId)) {
                await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            }
        }
    }

    private hasCapturedViewTypes(pluginId: string): boolean {
        // An empty mapping also records a completed capture for plugins with no views.
        return (this.ctx.getSettings().plugins[pluginId]?.lazyOptions?.viewTypes ?? []).length > 0 || Array.isArray(this.ctx.getSettings().lazyOnViews?.[pluginId]);
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
