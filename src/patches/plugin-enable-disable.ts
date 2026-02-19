import log from "loglevel";
import { around } from "monkey-around";
import type { Plugins } from "obsidian-typings";
import type { PluginContext } from "../core/plugin-context";
import type { PluginMode } from "../core/types";
import { PLUGIN_MODE } from "../core/types";
import type { CommandCacheService } from "../services/command-cache/command-cache-service";

const logger = log.getLogger("OnDemandPlugin/Patches/PluginEnableDisable");

/**
 * Observe & Sync strategy (案3):
 *
 * When the user toggles a plugin via Obsidian's UI (not through demand-plugins),
 * we sync the demand-plugins settings **only** for `keepEnabled` ↔ `disabled`
 * transitions. Lazy modes (`lazy`, `lazyOnView`, `lazyOnLayoutReady`) are left
 * untouched because:
 *   - Lazy plugins are already in a disabled state by design (commands are
 *     registered as wrappers, plugin loads on demand).
 *   - Changing their mode on a UI toggle would lose the user's lazy configuration.
 *   - On next startup, the lazy mode will be applied correctly regardless.
 */
export function patchPluginEnableDisable(ctx: PluginContext, commandCacheService: CommandCacheService): void {
    const obsidianPlugins = ctx.obsidianPlugins as unknown as Plugins;

    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);
                    await syncModeOnEnable(ctx, pluginId);
                    commandCacheService.syncCommandWrappersForPlugin(pluginId);
                    return result;
                },
            disablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);
                    await syncModeOnDisable(ctx, pluginId);
                    return result;
                },
        }),
    );
}

// alwaysDisabled → alwaysEnabled
async function syncModeOnEnable(ctx: PluginContext, pluginId: string): Promise<void> {
    const mode = ctx.getPluginMode(pluginId);
    logger.debug(`[LazyPlugins] enablePlugin patch: id=${pluginId}, mode=${mode}`);

    if (mode !== PLUGIN_MODE.ALWAYS_DISABLED) return;

    await updatePluginMode(ctx, pluginId, PLUGIN_MODE.ALWAYS_ENABLED);
    logger.debug(`[LazyPlugins] Synced settings: ${pluginId} alwaysDisabled → alwaysEnabled`);
}

// alwaysEnabled → alwaysDisabled
// Lazy modes are intentionally left untouched (see module-level comment).
async function syncModeOnDisable(ctx: PluginContext, pluginId: string): Promise<void> {
    const mode = ctx.getPluginMode(pluginId);
    logger.debug(`[LazyPlugins] disablePlugin patch: id=${pluginId}, mode=${mode}`);

    if (mode !== PLUGIN_MODE.ALWAYS_ENABLED) return;

    await updatePluginMode(ctx, pluginId, PLUGIN_MODE.ALWAYS_DISABLED);
    logger.debug(`[LazyPlugins] Synced settings: ${pluginId} alwaysEnabled → alwaysDisabled`);
}

async function updatePluginMode(ctx: PluginContext, pluginId: string, mode: PluginMode): Promise<void> {
    ctx.getSettings().plugins[pluginId] = { mode, userConfigured: true };
    await ctx.saveSettings();
}
