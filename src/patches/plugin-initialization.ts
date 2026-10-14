import { around } from "monkey-around";
import log from "loglevel";
import type { Workspace } from "obsidian";
import { Plugin } from "obsidian";
import pTimeout from "p-timeout";
import type { PluginContext } from "src/core/plugin-context";

type InitializationResult = { ok: true } | { ok: false; error: unknown };
const initializations = new WeakMap<Plugin, Promise<InitializationResult>>();
const logger = log.getLogger("OnDemandPlugin/PluginInitialization");
const INITIALIZATION_TIMEOUT_MS = 15_000;

/** Observe async onload without changing Obsidian's synchronous Component.load contract. */
export function patchPluginInitialization(): () => void {
    return around(Plugin.prototype, {
        load: (next) =>
            function (this: Plugin) {
                const restore = around(this, {
                    onload: (onload) =>
                        function (this: Plugin) {
                            const layoutReadyWork: unknown[] = [];
                            const restoreLayoutReady = trackLayoutReadyWork(this, layoutReadyWork);
                            let result: void | Promise<void>;
                            try {
                                result = onload.call(this);
                            } finally {
                                restoreLayoutReady();
                            }
                            // Handle rejections immediately, including loads that have no cache consumer.
                            initializations.set(
                                this,
                                Promise.all([result, ...layoutReadyWork]).then(
                                    (): InitializationResult => ({ ok: true }),
                                    (error: unknown): InitializationResult => {
                                        logger.warn("Plugin initialization failed", this.manifest?.id, error);
                                        return { ok: false, error };
                                    },
                                ),
                            );
                            return result;
                        },
                });
                try {
                    return next.call(this);
                } finally {
                    restore();
                }
            },
    });
}

/**
 * Once the layout is ready, Obsidian runs onLayoutReady callbacks synchronously and drops
 * their promises. Plugins such as Excalidraw register their commands from that async
 * callback, so a snapshot taken right after onload sees no commands, and unloading the
 * plugin mid-callback lets the rest of its setup run against an unloaded instance.
 * Only the synchronous part of onload is tracked: later calls cannot be attributed.
 */
function trackLayoutReadyWork(plugin: Plugin, work: unknown[]): () => void {
    const workspace = (plugin as Partial<Plugin>).app?.workspace;
    if (!workspace) return () => {};
    return around(workspace, {
        onLayoutReady: (next) =>
            function (this: Workspace, callback: () => unknown) {
                return next.call(this, function (this: unknown) {
                    const result = callback.call(this);
                    work.push(result);
                    return result;
                });
            },
    });
}

export async function waitForPluginInitialization(ctx: PluginContext, pluginId: string): Promise<void> {
    const plugin = ctx.obsidianPlugins.plugins?.[pluginId];
    const initialization = plugin && initializations.get(plugin);
    // Plugins loaded before our patch have already completed their normal startup.
    if (!initialization) return;
    const result = await pTimeout(initialization, {
        milliseconds: INITIALIZATION_TIMEOUT_MS,
        message: `Timeout initializing plugin ${pluginId}`,
    });
    if (!result.ok) throw result.error;
}
