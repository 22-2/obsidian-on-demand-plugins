import { around } from "monkey-around";
import log from "loglevel";
import type { Plugins } from "obsidian-typings";
import { PLUGIN_MODE } from "src/core/types";
import type { PluginContext } from "src/core/plugin-context";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";

const logger = log.getLogger("OnDemandPlugin/PluginEnableDisablePatch");

// ── Pure helpers (easy to unit-test) ─────────────────────────────────────────

/**
 * Sync command wrappers for a plugin via the lazy engine, if available.
 */
export function syncCommandWrappers(ctx: PluginContext, pluginId: string): void {
    const lazyEngine = ctx._plugin.features.get(LazyEngineFeature);
    if (!lazyEngine) throw new Error("LazyEngineFeature not found");
    lazyEngine.commandCache.syncCommandWrappersForPlugin(pluginId);
}

/**
 * Update plugin mode only when it matches the expected `fromMode`.
 * Preserves LAZY mode on both enable and disable paths.
 */
export async function syncPluginMode(ctx: PluginContext, pluginId: string, fromMode: PLUGIN_MODE, toMode: PLUGIN_MODE): Promise<void> {
    const mode = ctx.getPluginMode(pluginId);
    if (mode === fromMode) {
        await ctx._plugin.updatePluginSettings(pluginId, toMode);
    }
}

/**
 * Run the post-toggle sync steps after enable or disable, catching all errors
 * so Obsidian's core flow is never interrupted.
 */
export async function runPostToggleSync(ctx: PluginContext, pluginId: string, fromMode: PLUGIN_MODE, toMode: PLUGIN_MODE, label: "enablePlugin" | "disablePlugin"): Promise<void> {
    try {
        await syncPluginMode(ctx, pluginId, fromMode, toMode);
        syncCommandWrappers(ctx, pluginId);
    } catch (error) {
        // Intentionally log every failure so repeated instability remains visible.
        logger.warn(`${label} sync failed:`, error);
    }
}

// ── Patch ────────────────────────────────────────────────────────────────────

/**
 * Patch Obsidian's plugin enable/disable methods to keep On-Demand Plugin settings in sync.
 *
 * Lets users toggle plugins in the standard Community Plugins settings
 * without losing their lazy-loading configuration.
 */
export function patchPluginEnableDisable(ctx: PluginContext): void {
    const obsidianPlugins = ctx.obsidianPlugins;

    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next: Plugins["enablePlugin"]) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);

                    try {
                        // Only sync ALWAYS_DISABLED → ALWAYS_ENABLED; preserve LAZY mode.
                        await runPostToggleSync(ctx, pluginId, PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.ALWAYS_ENABLED, "enablePlugin");
                    } catch (error) {
                        logger.warn("enablePlugin sync failed:", error);
                    }

                    return result;
                },

            disablePlugin: (next: Plugins["disablePlugin"]) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);

                    try {
                        // Only sync ALWAYS_ENABLED → ALWAYS_DISABLED; preserve LAZY mode.
                        await runPostToggleSync(ctx, pluginId, PLUGIN_MODE.ALWAYS_ENABLED, PLUGIN_MODE.ALWAYS_DISABLED, "disablePlugin");
                    } catch (error) {
                        logger.warn("disablePlugin sync failed:", error);
                    }

                    return result;
                },
        }),
    );
}
