import { Mutex } from "async-mutex";
import log from "loglevel";
import type { PluginManifest } from "obsidian";
import type { Commands, Plugins } from "obsidian-typings";
import { ON_DEMAND_PLUGIN_ID } from "../../core/constants";
import type { PluginContext } from "../../core/plugin-context";
import { ProgressDialog } from "../../core/progress";
import { saveJSON } from "../../core/storage";
import { PLUGIN_MODE } from "../../core/types";
import { isPluginEnabled, isPluginLoaded } from "../../core/utils";
import type { CommandCacheService } from "../command-cache/command-cache-service";
import type { PluginRegistry } from "../registry/plugin-registry";

const logger = log.getLogger("OnDemandPlugin/StartupPolicyService");

/**
 * Manages plugin startup policies and lifecycle.
 * Handles lazy loading, view-based loading, and persistent plugin states
 * with progress UI and cancellation support.
 */
export class StartupPolicyService {
    private mutex = new Mutex();
    private originalRegisterView: ((type: string, creator: unknown) => unknown) | null = null;

    constructor(
        private ctx: PluginContext,
        private commandCacheService: CommandCacheService,
        private registry: PluginRegistry,
    ) {}

    /** Apply startup policy (debounced + serialized via mutex). */
    // public apply = debounce(async (pluginIds?: string[]) => {
    //     await this.mutex.runExclusive(() => this.executeStartupPolicy(pluginIds));
    // }, 100);

    /** Apply startup policy reusing an externally created ProgressDialog. */
    public async applyWithProgress(progress: ProgressDialog | null, pluginIds?: string[]) {
        await this.mutex.runExclusive(() => this.executeStartupPolicy(pluginIds, progress));
    }

    // -------------------------------------------------------------------------
    // Core execution
    // -------------------------------------------------------------------------

    private async executeStartupPolicy(pluginIds?: string[], externalProgress?: ProgressDialog | null) {
        const targetIds = pluginIds?.length ? new Set(pluginIds) : null;
        const allManifests = this.ctx.getManifests();
        const targetManifests = targetIds ? allManifests.filter((p) => targetIds.has(p.id)) : allManifests;
        const lazyManifests = this.getLazyManifests(targetManifests);

        let cancelled = false;
        const progress = externalProgress
            ? (externalProgress.setOnCancel(() => {
                  cancelled = true;
              }),
              externalProgress.setTotal(lazyManifests.length + 2),
              externalProgress)
            : this.openProgressDialog(lazyManifests.length, () => {
                  cancelled = true;
              });

        const lazyOnViews: Record<string, string[]> = {
            ...(this.ctx.getSettings().lazyOnViews ?? {}),
        };
        const stopIntercepting = this.interceptViewRegistry(lazyOnViews);

        try {
            await this.loadLazyPluginsWithProgress(lazyManifests, targetIds, progress, () => cancelled);
        } finally {
            await this.cleanupAndReload(lazyOnViews, !cancelled, progress, stopIntercepting);
        }
    }

    // -------------------------------------------------------------------------
    // View registry interception
    // -------------------------------------------------------------------------

    /**
     * Monkey-patches ViewRegistry.registerView to capture which view types
     * each lazy plugin registers. Returns a cleanup function.
     */
    private interceptViewRegistry(lazyOnViews: Record<string, string[]>): () => void {
        const { viewRegistry } = this.ctx.app as unknown as {
            viewRegistry?: { registerView?: (type: string, creator: unknown) => unknown };
        };

        this.originalRegisterView = viewRegistry?.registerView ?? null;
        if (!viewRegistry || typeof this.originalRegisterView !== "function") {
            return () => {};
        }

        const settings = this.ctx.getSettings();

        viewRegistry.registerView = (type: string, creator: unknown) => {
            const loadingId = (this.ctx.app as unknown as { plugins: Plugins }).plugins.loadingPluginId as string | undefined;

            if (loadingId && type) {
                const mode = this.ctx.getPluginMode(loadingId);
                const pluginSettings = settings.plugins[loadingId];
                const isLazyWithUseView = mode === PLUGIN_MODE.LAZY && pluginSettings?.lazyOptions?.useView === true;

                if (isLazyWithUseView) {
                    lazyOnViews[loadingId] ??= [];
                    if (!lazyOnViews[loadingId].includes(type)) {
                        lazyOnViews[loadingId].push(type);
                    }

                    if (isLazyWithUseView && pluginSettings?.lazyOptions) {
                        pluginSettings.lazyOptions.viewTypes ??= [];
                        if (!pluginSettings.lazyOptions.viewTypes.includes(type)) {
                            pluginSettings.lazyOptions.viewTypes.push(type);
                        }
                    }
                }
            }

            return this.originalRegisterView!.apply(viewRegistry, [type, creator]);
        };

        return () => {
            viewRegistry.registerView = this.originalRegisterView!;
        };
    }

    // -------------------------------------------------------------------------
    // Plugin loading
    // -------------------------------------------------------------------------

    private getLazyManifests(manifests: PluginManifest[]): PluginManifest[] {
        return manifests.filter((plugin) => {
            const mode = this.ctx.getPluginMode(plugin.id);
            if (mode === PLUGIN_MODE.LAZY) {
                return this.ctx.getSettings().plugins[plugin.id]?.lazyOptions?.useView === true;
            }
            return false;
        });
    }

    private async loadLazyPluginsWithProgress(manifests: PluginManifest[], targetIds: Set<string> | null, progress: ProgressDialog | null, isCancelled: () => boolean) {
        // 1. Enable each plugin sequentially
        for (let i = 0; i < manifests.length; i++) {
            if (isCancelled()) return;
            const plugin = manifests[i];
            progress?.setStatus(`Loading ${plugin.name}`);
            progress?.setProgress(i + 1);

            const alreadyReady = isPluginLoaded(this.ctx.app, plugin.id) && isPluginEnabled(this.ctx.obsidianPlugins.enabledPlugins, plugin.id);

            if (!alreadyReady) {
                try {
                    await this.ctx.obsidianPlugins.enablePlugin(plugin.id);
                } catch (error) {
                    logger.warn("Failed to load plugin", plugin.id, error);
                }
            }
        }

        if (isCancelled()) return;

        // 2. Wait for all to finish registering
        progress?.setStatus("Waiting for plugins to finish registering…");
        await this.waitForPlugins(
            manifests.map((p) => p.id),
            15_000,
            isCancelled,
        );
        progress?.setProgress(manifests.length + 1);

        if (isCancelled()) return;

        // 3. Rebuild command cache
        progress?.setStatus("Rebuilding command cache…");
        await this.commandCacheService.refreshCommandCache(targetIds ? Array.from(targetIds) : undefined);
        progress?.setProgress(manifests.length + 2);
    }

    /** Poll until all plugin IDs are loaded, or timeout / cancelled. */
    private async waitForPlugins(ids: string[], timeoutMs: number, isCancelled: () => boolean): Promise<void> {
        if (!ids.length) return;
        const deadline = Date.now() + timeoutMs;
        while (true) {
            if (isCancelled() || ids.every((id) => isPluginLoaded(this.ctx.app, id))) return;
            if (Date.now() >= deadline) return;
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // -------------------------------------------------------------------------
    // Cleanup & persistence
    // -------------------------------------------------------------------------

    private async cleanupAndReload(lazyOnViews: Record<string, string[]>, shouldReload: boolean, progress: ProgressDialog | null, stopIntercepting: () => void) {
        stopIntercepting();

        // Persist lazyOnViews
        const settings = this.ctx.getSettings();
        settings.lazyOnViews = lazyOnViews;
        await this.ctx.saveSettings();
        saveJSON(this.ctx.app, "lazyOnViews", lazyOnViews);

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

        progress?.close();
    }

    // -------------------------------------------------------------------------
    // UI helpers
    // -------------------------------------------------------------------------

    private openProgressDialog(total: number, onCancel: () => void): ProgressDialog {
        const dialog = new ProgressDialog(this.ctx.app, {
            title: "Applying plugin startup policy",
            total: total + 2,
            cancellable: true,
            cancelText: "Cancel",
            onCancel,
        });
        dialog.open();
        return dialog;
    }
}
