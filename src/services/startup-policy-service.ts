import { App, PluginManifest } from "obsidian";
import log from "loglevel";
import { ProgressDialog } from "../utils/progress";
import { ON_DEMAND_PLUGIN_ID } from "../utils/constants";
import { isPluginLoaded, isPluginEnabled } from "../utils/utils";
import { PluginMode } from "../settings";
import { Commands, Plugins } from "obsidian-typings";

const logger = log.getLogger("OnDemandPlugin/StartupPolicyService");

interface StartupPolicyDeps {
    app: App;
    obsidianPlugins: {
        enabledPlugins: Set<string>;
        plugins?: Record<string, { _loaded?: boolean }>;
        enablePlugin: (id: string) => Promise<void | boolean>;
    };
    getManifests: () => PluginManifest[];
    getPluginMode: (pluginId: string) => PluginMode;
    applyPluginState: (pluginId: string) => Promise<void>;
    writeCommunityPluginsFile: (enabledPlugins: string[]) => Promise<void>;
    getlazyOnViews: () => Record<string, string[]> | undefined;
    savelazyOnViews: (next: Record<string, string[]>) => Promise<void>;
    ensurePluginLoaded: (pluginId: string) => Promise<boolean>;
    refreshCommandCache: (pluginIds?: string[]) => Promise<void>;
}

export class StartupPolicyService {
    private startupPolicyLock: Promise<void> | null = null;
    private startupPolicyPending = false;
    private startupPolicyDebounceTimer: number | null = null;
    private startupPolicyDebounceMs = 100;

    constructor(private deps: StartupPolicyDeps) {}

    /**
     * Apply plugin startup policy with progress indicator and reload support.
     * @param pluginIds - Optional list of plugin IDs to apply policy to; if omitted, applies to all
     */
    async apply(pluginIds?: string[]) {
        if (this.startupPolicyLock) {
            this.startupPolicyPending = true;
            await this.startupPolicyLock;
            if (this.startupPolicyPending) {
                this.startupPolicyPending = false;
                await this.apply(pluginIds);
            }
            return;
        }

        this.startupPolicyLock = this.runApply(pluginIds);
        try {
            await this.startupPolicyLock;
        } finally {
            this.startupPolicyLock = null;
        }

        if (this.startupPolicyPending) {
            this.startupPolicyPending = false;
            await this.apply();
        }
    }

    private async runApply(pluginIds?: string[]) {
        await this.debounce();

        const manifests = this.deps.getManifests();
        const targetPluginIds = pluginIds?.length ? new Set(pluginIds) : null;
        const targetManifests = this.getTargetManifests(
            manifests,
            targetPluginIds,
        );
        const lazyManifests = this.getLazyManifests(targetManifests);

        let cancelled = false;
        const progress = this.createProgressDialog(
            lazyManifests.length,
            () => {
                cancelled = true;
            },
        );

        const lazyOnViews: Record<string, string[]> = {
            ...(this.deps.getlazyOnViews() ?? {}),
        };
        const viewRegistryCleanup = this.patchViewRegistry(lazyOnViews);

        try {
            await this.applyWithProgress(
                lazyManifests,
                targetPluginIds,
                progress,
                () => cancelled,
            );
        } finally {
            await this.finalize(
                viewRegistryCleanup,
                lazyOnViews,
                !cancelled,
                progress,
            );
        }
    }

    private async debounce() {
        if (this.startupPolicyDebounceTimer) {
            window.clearTimeout(this.startupPolicyDebounceTimer);
        }

        await new Promise<void>((resolve) => {
            this.startupPolicyDebounceTimer = window.setTimeout(() => {
                this.startupPolicyDebounceTimer = null;
                resolve();
            }, this.startupPolicyDebounceMs);
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
        return manifests.filter((plugin) => {
            const mode = this.deps.getPluginMode(plugin.id);
            return mode === "lazy" || mode === "lazyOnView";
        });
    }

    private createProgressDialog(
        total: number,
        onCancel: () => void,
    ): ProgressDialog {
        const progress = new ProgressDialog(this.deps.app, {
            title: "Applying plugin startup policy",
            total: total + 2,
            cancellable: true,
            cancelText: "Cancel",
            onCancel,
        });
        progress.open();
        return progress;
    }

    private patchViewRegistry(lazyOnViews: Record<string, string[]>) {
        const { viewRegistry } = this.deps.app as unknown as {
            viewRegistry?: {
                registerView?: (type: string, creator: unknown) => unknown;
            };
        };

        const originalRegisterView = viewRegistry?.registerView;
        if (!viewRegistry || typeof originalRegisterView !== "function") {
            return () => {};
        }

        viewRegistry.registerView = (type: string, creator: unknown) => {
            const loadingPluginId = (
                this.deps.app as unknown as { plugins: Plugins }
            ).plugins.loadingPluginId as string | undefined;

            if (
                loadingPluginId &&
                this.deps.getPluginMode(loadingPluginId) === "lazyOnView" &&
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

            return originalRegisterView.apply(viewRegistry, [type, creator]);
        };

        return () => {
            if (viewRegistry && originalRegisterView) {
                viewRegistry.registerView = originalRegisterView;
            }
        };
    }

    private async applyWithoutProgress(
        targetManifests: PluginManifest[],
        progress: ProgressDialog | null,
    ) {
        for (let index = 0; index < targetManifests.length; index += 1) {
            const plugin = targetManifests[index];
            progress?.setStatus(`Applying ${plugin.name}`);
            progress?.setProgress(index + 1);

            if (this.deps.getPluginMode(plugin.id) === "lazyOnView") {
                await this.deps.ensurePluginLoaded(plugin.id);
            }
            await this.deps.applyPluginState(plugin.id);
        }
    }

    private async applyWithProgress(
        lazyManifests: PluginManifest[],
        targetPluginIds: Set<string> | null,
        progress: ProgressDialog | null,
        isCancelled: () => boolean,
    ) {
        for (let index = 0; index < lazyManifests.length; index += 1) {
            if (isCancelled()) break;

            const plugin = lazyManifests[index];
            progress?.setStatus(`Loading ${plugin.name}`);
            progress?.setProgress(index + 1);

            const loaded = isPluginLoaded(
                this.deps.obsidianPlugins.plugins,
                plugin.id,
            );
            const enabled = isPluginEnabled(
                this.deps.obsidianPlugins.enabledPlugins,
                plugin.id,
            );

            if (!enabled || !loaded) {
                try {
                    await this.deps.obsidianPlugins.enablePlugin(plugin.id);
                } catch (error) {
                    logger.warn("Failed to load plugin", plugin.id, error);
                }
            }
        }

        if (isCancelled()) return;

        progress?.setStatus("Waiting for plugins to finish registering…");
        const pluginIds = lazyManifests.map((plugin) => plugin.id);
        await this.waitForAllPluginsLoaded(pluginIds, 1000 * 15);
        progress?.setProgress(lazyManifests.length + 1);

        if (isCancelled()) return;

        progress?.setStatus("Rebuilding command cache…");
        await this.deps.refreshCommandCache(
            targetPluginIds ? Array.from(targetPluginIds) : undefined,
        );
        progress?.setProgress(lazyManifests.length + 2);
    }

    private async finalize(
        viewRegistryCleanup: () => void,
        lazyOnViews: Record<string, string[]>,
        shouldReload: boolean,
        progress: ProgressDialog | null,
    ) {
        viewRegistryCleanup();

        for (const plugin of this.deps.getManifests()) {
            if (this.deps.getPluginMode(plugin.id) !== "lazyOnView") {
                delete lazyOnViews[plugin.id];
            }
        }
        await this.deps.savelazyOnViews(lazyOnViews);

        const desiredEnabled = new Set<string>();
        this.deps.getManifests().forEach((plugin) => {
            if (this.deps.getPluginMode(plugin.id) === "keepEnabled") {
                desiredEnabled.add(plugin.id);
            }
        });
        desiredEnabled.add(ON_DEMAND_PLUGIN_ID);

        this.deps.obsidianPlugins.enabledPlugins.clear();
        desiredEnabled.forEach((pluginId) => {
            this.deps.obsidianPlugins.enabledPlugins.add(pluginId);
        });

        await this.deps.writeCommunityPluginsFile(
            [...desiredEnabled].sort((a, b) => a.localeCompare(b)),
        );

        if (shouldReload) {
            try {
                await (
                    this.deps.app as unknown as { commands: Commands }
                ).commands.executeCommandById("app:reload");
            } catch (error) {
                logger.warn("Failed to reload app after apply", error);
            }
        }

        progress?.close();
    }

    /**
     * Wait for specified plugins to fully load with timeout.
     * @param pluginIds - List of plugin IDs to wait for
     * @param timeoutMs - Maximum time to wait in milliseconds
     * @returns True if all plugins loaded within timeout, false otherwise
     */
    private async waitForAllPluginsLoaded(
        pluginIds: string[],
        timeoutMs: number,
    ): Promise<boolean> {
        if (!pluginIds.length) return true;

        const startedAt = Date.now();

        while (true) {
            if (
                pluginIds.every((pluginId) =>
                    isPluginLoaded(
                        this.deps.obsidianPlugins.plugins,
                        pluginId,
                    ),
                )
            ) {
                return true;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                return false;
            }

            // Sleep for a short duration before checking again
            await sleep(100);
        }
    }
}
