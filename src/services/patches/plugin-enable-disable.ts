import { around } from "monkey-around";
import { Plugins } from "obsidian-typings";
import { PluginContext } from "../../core/plugin-context";
import { CommandCacheService } from "../command-cache/command-cache-service";
import { PluginMode } from "../../core/types";

/**
 * Returns true for lazy modes that use command-based lazy loading
 * (i.e. modes where command wrappers should be re-registered on disable).
 *
 * `lazyOnLayoutReady` is excluded because it loads plugins at layout ready time,
 * not via command wrappers. Re-registering commands for it would trigger
 * `ensureCommandsCached` → `getCommandsForPlugin` → `enablePlugin`, which
 * undoes the user's disable action.
 */
function isCommandBasedLazyMode(mode: PluginMode): boolean {
    return mode === "lazy" || mode === "lazyOnView";
}

export function patchPluginEnableDisable(
    ctx: PluginContext,
    commandCacheService: CommandCacheService,
): void {
    const obsidianPlugins = ctx.obsidianPlugins as unknown as Plugins;

    // Monkey-patch `Plugins.enablePlugin` / `Plugins.disablePlugin` to handle
    // when a user manually enables or disables a plugin: update the command
    // cache and re-register lazy commands as needed.
    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);
                    commandCacheService.syncCommandWrappersForPlugin(pluginId);
                    return result;
                },
            disablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);
                    const mode = ctx.getPluginMode(pluginId);
                    // Re-register lazy commands on disable only for command-based lazy modes
                    // (lazy, lazyOnView). lazyOnLayoutReady does not use command wrappers.
                    const settings = ctx.getSettings();
                    const shouldReRegister =
                        settings.reRegisterLazyCommandsOnDisable ?? true;
                    if (shouldReRegister && isCommandBasedLazyMode(mode)) {
                        await commandCacheService.ensureCommandsCached(
                            pluginId,
                        );
                        commandCacheService.registerCachedCommandsForPlugin(
                            pluginId,
                        );
                    }
                    return result;
                },
        }),
    );
}
