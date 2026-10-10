import { around } from "monkey-around";
import log from "loglevel";
import { Plugin } from "obsidian";
import pTimeout from "p-timeout";
import type { PluginContext } from "src/core/plugin-context";

type InitializationResult = { ok: true } | { ok: false; error: unknown };
const initializations = new WeakMap<Plugin, Promise<InitializationResult>>();
const logger = log.getLogger("OnDemandPlugin/PluginInitialization");

/** Observe async onload without changing Obsidian's synchronous Component.load contract. */
export function patchPluginInitialization(): () => void {
    return around(Plugin.prototype, {
        load: (next) =>
            function (this: Plugin) {
                const restore = around(this, {
                    onload: (onload) =>
                        function (this: Plugin) {
                            const result = onload.call(this);
                            // Handle rejections immediately, including loads that have no cache consumer.
                            initializations.set(
                                this,
                                Promise.resolve(result).then(
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

export async function waitForPluginInitialization(ctx: PluginContext, pluginId: string): Promise<void> {
    const plugin = ctx.obsidianPlugins.plugins?.[pluginId];
    const initialization = plugin && initializations.get(plugin);
    // Plugins loaded before our patch have already completed their normal startup.
    if (!initialization) return;
    const result = await pTimeout(initialization, {
        milliseconds: 15_000,
        message: `Timeout initializing plugin ${pluginId}`,
    });
    if (!result.ok) throw result.error;
}
