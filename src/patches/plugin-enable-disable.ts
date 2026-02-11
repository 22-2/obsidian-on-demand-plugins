import { around } from "monkey-around";
import { Plugins } from "obsidian-typings";
import { PluginContext } from "../core/plugin-context";
import { CommandCacheService } from "../features/command-cache/command-cache-service";
import { isLazyMode } from "../utils/utils";

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
                    // Re-register lazy commands on disable applies to both "lazy" and "lazyOnView" modes
                    const settings = ctx.getSettings();
                    const shouldReRegister =
                        settings.reRegisterLazyCommandsOnDisable ?? true;
                    if (
                        shouldReRegister &&
                        isLazyMode(mode)
                    ) {
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
