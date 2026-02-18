import { App, PluginManifest, debounce } from "obsidian";
import { saveJSON } from "../../core/storage";
import log from "loglevel";
import { ProgressDialog } from "../../core/progress";
import { ON_DEMAND_PLUGIN_ID } from "../../core/constants";
import { isPluginLoaded, isPluginEnabled, isLazyMode } from "../../core/utils";
import { PluginMode } from "../../core/types";
import { Commands, Plugins } from "obsidian-typings";
import { Mutex } from "async-mutex";
import pWaitFor from "p-wait-for";
import { PluginContext } from "../../core/plugin-context";
import { CommandCacheService } from "../command-cache/command-cache-service";
import { PluginRegistry } from "../registry/plugin-registry";

const logger = log.getLogger("OnDemandPlugin/StartupPolicyService");

/**
 * Manage interception of the ViewRegistry
 */
class ViewRegistryInterceptor {
    private originalRegisterView:
        | ((type: string, creator: unknown) => unknown)
        | null = null;

    constructor(
        private app: App,
        private getPluginMode: (pluginId: string) => PluginMode,
    ) {}

    /**
     * Intercept ViewRegistry.registerView to record view registrations
     * for lazyOnView plugins
     */
    intercept(lazyOnViews: Record<string, string[]>): () => void {
        const { viewRegistry } = this.app as unknown as {
            viewRegistry?: {
                registerView?: (type: string, creator: unknown) => unknown;
            };
        };

        this.originalRegisterView = viewRegistry?.registerView ?? null;
        if (!viewRegistry || typeof this.originalRegisterView !== "function") {
            return () => {};
        }

        viewRegistry.registerView = (type: string, creator: unknown) => {
            const loadingPluginId = (
                this.app as unknown as { plugins: Plugins }
            ).plugins.loadingPluginId as string | undefined;

            if (
                loadingPluginId &&
                this.getPluginMode(loadingPluginId) === "lazyOnView" &&
                typeof type === "string" &&
                type.length > 0
            ) {
                if (!lazyOnViews[loadingPluginId]) {
                    lazyOnViews[loadingPluginId] = [];
                }
                if (!lazyOnViews[loadingPluginId].includes(type)) {
                    lazyOnViews[loadingPluginId].push(type);
                }
            }

            return this.originalRegisterView!.apply(viewRegistry, [
                type,
                creator,
            ]);
        };

        return () => this.restore(viewRegistry);
    }

    private restore(viewRegistry: {
        registerView?: (type: string, creator: unknown) => unknown;
    }) {
        if (viewRegistry && this.originalRegisterView) {
            viewRegistry.registerView = this.originalRegisterView;
        }
    }
}

/**
 * Helper to wait for plugin load completion
 */
class PluginLoadWaiter {
    constructor(private app: any) {}

    /**
     * Wait until all specified plugins have finished loading
     */
    async waitForAll(pluginIds: string[], timeoutMs: number): Promise<boolean> {
        if (!pluginIds.length) return true;

        try {
            await pWaitFor(
                () => pluginIds.every((id) => isPluginLoaded(this.app, id)),
                { interval: 100, timeout: timeoutMs },
            );
            return true;
        } catch (error) {
            // timeout
            return false;
        }
    }

    /**
     * Cancellable wait
     */
    async waitForAllCancellable(
        pluginIds: string[],
        timeoutMs: number,
        isCancelled: () => boolean,
    ): Promise<boolean> {
        if (!pluginIds.length) return true;

        const checkInterval = 100;
        const startedAt = Date.now();

        while (true) {
            if (isCancelled()) return false;

            if (pluginIds.every((id) => isPluginLoaded(this.app, id))) {
                return true;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                return false;
            }

            await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }
    }
}

/**
 * Helper to centralize persistence operations
 */
class PersistenceManager {
    constructor(
        private app: App,
        private ctx: PluginContext,
        private registry: PluginRegistry,
    ) {}

    /**
     * Persist lazyOnViews (remote + local)
     */
    async savelazyOnViews(
        lazyOnViews: Record<string, string[]>,
    ): Promise<void> {
        const settings = this.ctx.getSettings();
        settings.lazyOnViews = lazyOnViews;
        await this.ctx.saveSettings();
        // Also persist lazy-on-view registry locally per-vault
        saveJSON(this.app, "lazyOnViews", lazyOnViews);
    }

    /**
     * Write the community-plugins file
     */
    async writeCommunityPlugins(enabledPlugins: Set<string>): Promise<void> {
        // Write whatever set the caller provides. Caller is responsible
        // for filtering to the desired set (e.g. `keepEnabled` only).
        await this.registry.writeCommunityPluginsFile(
            [...enabledPlugins].sort((a, b) => a.localeCompare(b)),
            this.ctx.getData().showConsoleLog,
        );
    }
}

/**
 * Plugin loader with progress indicator
 */
class PluginBulkLoader {
    constructor(
        private ctx: PluginContext,
        private commandCacheService: CommandCacheService,
    ) {}

    /**
     * Load plugins sequentially and update progress
     */
    async loadWithProgress(
        manifests: PluginManifest[],
        progress: ProgressDialog | null,
        isCancelled: () => boolean,
    ): Promise<void> {
        for (let index = 0; index < manifests.length; index += 1) {
            if (isCancelled()) break;

            const plugin = manifests[index];
            progress?.setStatus(`Loading ${plugin.name}`);
            progress?.setProgress(index + 1);

            const loaded = isPluginLoaded(this.ctx.app, plugin.id);
            const enabled = isPluginEnabled(
                this.ctx.obsidianPlugins.enabledPlugins,
                plugin.id,
            );

            if (!enabled || !loaded) {
                try {
                    await this.ctx.obsidianPlugins.enablePlugin(plugin.id);
                } catch (error) {
                    logger.warn("Failed to load plugin", plugin.id, error);
                }
            }
        }
    }

    /**
     * Rebuild the command cache
     */
    async rebuildCommandCache(
        pluginIds?: string[],
        progress?: ProgressDialog | null,
        progressValue?: number,
    ): Promise<void> {
        progress?.setStatus("Rebuilding command cache…");
        await this.commandCacheService.refreshCommandCache(pluginIds);
        if (progress && progressValue !== undefined) {
            progress.setProgress(progressValue);
        }
    }
}

/**
 * Manages plugin startup policies and lifecycle.
 * Handles lazy loading, view-based loading, and persistent plugin states with progress UI and cancellation support.
 */
export class StartupPolicyService {
    private mutex = new Mutex();
    private viewRegistryInterceptor: ViewRegistryInterceptor;
    private pluginLoadWaiter: PluginLoadWaiter;
    private persistenceManager: PersistenceManager;
    private pluginBulkLoader: PluginBulkLoader;

    constructor(
        private ctx: PluginContext,
        commandCacheService: CommandCacheService,
        registry: PluginRegistry,
    ) {
        this.viewRegistryInterceptor = new ViewRegistryInterceptor(
            ctx.app,
            (pluginId) => ctx.getPluginMode(pluginId),
        );
        this.pluginLoadWaiter = new PluginLoadWaiter(ctx.app);
        this.persistenceManager = new PersistenceManager(
            ctx.app,
            ctx,
            registry,
        );
        this.pluginBulkLoader = new PluginBulkLoader(ctx, commandCacheService);
    }

    /**
     * Apply plugin startup policy with progress indicator and reload support.
     * Serialized using debounce + mutex
     */
    public apply = debounce(async (pluginIds?: string[]) => {
        await this.mutex.runExclusive(async () => {
            await this.executeStartupPolicy(pluginIds);
        });
    }, 100);

    private async executeStartupPolicy(
        pluginIds?: string[],
        externalProgress?: ProgressDialog | null,
    ) {
        const manifests = this.ctx.getManifests();
        const targetPluginIds = pluginIds?.length ? new Set(pluginIds) : null;
        const targetManifests = this.getTargetManifests(
            manifests,
            targetPluginIds,
        );
        const lazyManifests = this.getLazyManifests(targetManifests);

        let cancelled = false;
        // Use an externally supplied progress dialog when provided, otherwise create one.
        const progress =
            externalProgress ??
            this.createProgressDialog(lazyManifests.length, () => {
                cancelled = true;
            });

        if (externalProgress) {
            // Ensure cancel from external dialog sets our cancelled flag and totals align.
            externalProgress.setOnCancel(() => {
                cancelled = true;
            });
            externalProgress.setTotal(lazyManifests.length + 2);
        }

        const lazyOnViews: Record<string, string[]> = {
            ...(this.ctx.getSettings().lazyOnViews ?? {}),
        };
        const viewRegistryCleanup =
            this.viewRegistryInterceptor.intercept(lazyOnViews);

        try {
            await this.loadLazyPluginsWithProgress(
                lazyManifests,
                targetPluginIds,
                progress,
                () => cancelled,
            );
        } finally {
            await this.cleanupAndReload(
                viewRegistryCleanup,
                lazyOnViews,
                !cancelled,
                progress,
            );
        }
    }

    /**
     * Apply startup policy but reuse an externally created ProgressDialog (optional).
     * This allows callers to show a unified progress UI covering command cache rebuild + apply.
     */
    public async applyWithProgress(
        progress: ProgressDialog | null,
        pluginIds?: string[],
    ) {
        await this.mutex.runExclusive(async () => {
            await this.executeStartupPolicy(pluginIds, progress);
        });
    }

    private getTargetManifests(
        manifests: PluginManifest[],
        targetPluginIds: Set<string> | null,
    ) {
        return targetPluginIds
            ? manifests.filter((plugin) => targetPluginIds.has(plugin.id))
            : manifests;
    }

    private getLazyManifests(manifests: PluginManifest[]) {
        // Only legacy `lazyOnView` plugins need to be loaded during the
        // startup apply step so we can detect view registrations. Regular
        // `lazy` plugins should not be enabled at startup.
        return manifests.filter(
            (plugin) => this.ctx.getPluginMode(plugin.id) === "lazyOnView",
        );
    }

    private createProgressDialog(
        total: number,
        onCancel: () => void,
    ): ProgressDialog {
        const progress = new ProgressDialog(this.ctx.app, {
            title: "Applying plugin startup policy",
            total: total + 2,
            cancellable: true,
            cancelText: "Cancel",
            onCancel,
        });
        progress.open();
        return progress;
    }

    private async loadLazyPluginsWithProgress(
        lazyManifests: PluginManifest[],
        targetPluginIds: Set<string> | null,
        progress: ProgressDialog | null,
        isCancelled: () => boolean,
    ) {
        await this.pluginBulkLoader.loadWithProgress(
            lazyManifests,
            progress,
            isCancelled,
        );

        if (isCancelled()) return;

        progress?.setStatus("Waiting for plugins to finish registering…");
        const pluginIds = lazyManifests.map((plugin) => plugin.id);
        await this.pluginLoadWaiter.waitForAllCancellable(
            pluginIds,
            15 * 1000,
            isCancelled,
        );
        progress?.setProgress(lazyManifests.length + 1);

        if (isCancelled()) return;

        await this.pluginBulkLoader.rebuildCommandCache(
            targetPluginIds ? Array.from(targetPluginIds) : undefined,
            progress,
            lazyManifests.length + 2,
        );
    }

    private async cleanupAndReload(
        viewRegistryCleanup: () => void,
        lazyOnViews: Record<string, string[]>,
        shouldReload: boolean,
        progress: ProgressDialog | null,
    ) {
        viewRegistryCleanup();

        // Remove entries that are not lazyOnView
        for (const plugin of this.ctx.getManifests()) {
            if (this.ctx.getPluginMode(plugin.id) !== "lazyOnView") {
                delete lazyOnViews[plugin.id];
            }
        }
        await this.persistenceManager.savelazyOnViews(lazyOnViews);

        // Keep only plugins with `keepEnabled` in the enabled list
        const desiredEnabled = new Set<string>();
        this.ctx.getManifests().forEach((plugin) => {
            if (this.ctx.getPluginMode(plugin.id) === "keepEnabled") {
                desiredEnabled.add(plugin.id);
            }
        });
        desiredEnabled.add(ON_DEMAND_PLUGIN_ID);

        this.ctx.obsidianPlugins.enabledPlugins.clear();
        desiredEnabled.forEach((pluginId) => {
            this.ctx.obsidianPlugins.enabledPlugins.add(pluginId);
        });

        // Ensure only `keepEnabled` plugins (plus the on-demand plugin) are persisted.
        const toPersist = new Set<string>(
            [...desiredEnabled].filter(
                (id) =>
                    this.ctx.getPluginMode(id) === "keepEnabled" ||
                    id === ON_DEMAND_PLUGIN_ID,
            ),
        );

        await this.persistenceManager.writeCommunityPlugins(toPersist);

        if (shouldReload) {
            try {
                (
                    this.ctx.app as unknown as { commands: Commands }
                ).commands.executeCommandById("app:reload");
            } catch (error) {
                logger.warn("Failed to reload app after apply", error);
            }
        }

        progress?.close();
    }
}
