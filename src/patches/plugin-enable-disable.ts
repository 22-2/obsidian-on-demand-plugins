import { around } from "monkey-around";
import type { Plugins } from "obsidian-typings";
import { PLUGIN_MODE } from "../core/types";
import type { PluginContext } from "../core/plugin-context";
import { LazyEngineFeature } from "../features/lazy-engine/lazy-engine-feature";

/**
 * Patch Obsidian's plugin enable/disable methods to keep On-Demand Plugins settings in sync.
 *
 * This allows the user to manually toggle plugins in the standard Obsidian Community Plugins settings,
 * without losing their lazy-loading configuration.
 */
export function patchPluginEnableDisable(ctx: PluginContext): void {
    const obsidianPlugins = ctx.obsidianPlugins;

    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next: Plugins["enablePlugin"]) =>
                async function (this: Plugins, pluginId: string) {
                    const callNext = next as (this: Plugins, pluginId: string) => ReturnType<Plugins["enablePlugin"]>;
                    await callNext.call(this, pluginId);

                    // Only sync if the mode was ALWAYS_DISABLED. If it's a LAZY mode, 
                    // we want to preserve that setting for the next start.
                    const mode = ctx.getPluginMode(pluginId);
                    if (mode === PLUGIN_MODE.ALWAYS_DISABLED) {
                        await ctx._plugin.updatePluginSettings(pluginId, PLUGIN_MODE.ALWAYS_ENABLED);
                    }

                    // For lazy plugins, clear our command wrappers so the real ones take over.
                    const lazyEngine = ctx._plugin.features.get(LazyEngineFeature);
                    if (lazyEngine) {
                        lazyEngine.commandCache.syncCommandWrappersForPlugin(pluginId);
                    }

                    return;
                },
            disablePlugin: (next: Plugins["disablePlugin"]) =>
                async function (this: Plugins, pluginId: string) {
                    const callNext = next as (this: Plugins, pluginId: string) => ReturnType<Plugins["disablePlugin"]>;
                    await callNext.call(this, pluginId);

                    // Only sync if the mode was ALWAYS_ENABLED. If it's a LAZY mode, 
                    // we preserve it. It will be successfully initialized with wrappers on the next start.
                    const mode = ctx.getPluginMode(pluginId);
                    if (mode === PLUGIN_MODE.ALWAYS_ENABLED) {
                        await ctx._plugin.updatePluginSettings(pluginId, PLUGIN_MODE.ALWAYS_DISABLED);
                    }

                    // For lazy plugins, re-add our command wrappers since the real plugin was disabled.
                    const lazyEngine = ctx._plugin.features.get(LazyEngineFeature);
                    if (lazyEngine) {
                        lazyEngine.commandCache.syncCommandWrappersForPlugin(pluginId);
                    }

                    return;
                },
        }),
    );
}
