import { around } from "monkey-around";
import { Plugins } from "obsidian-typings";
import { DeviceSettings, PluginMode } from "../settings";
import { CommandCacheService } from "../services/command-cache-service";

interface PatchPluginEnableDisableDeps {
    register: (unload: () => void) => void;
    obsidianPlugins: Plugins;
    getPluginMode: (pluginId: string) => PluginMode;
    settings: DeviceSettings;
    commandCacheService: CommandCacheService;
}

export function patchPluginEnableDisable(
    deps: PatchPluginEnableDisableDeps,
): void {
    const {
        register,
        obsidianPlugins,
        getPluginMode,
        settings,
        commandCacheService,
    } = deps;

    // Monkey-patch `Plugins.enablePlugin` / `Plugins.disablePlugin` to handle
    // when a user manually enables or disables a plugin: update the command
    // cache and re-register lazy commands as needed.
    register(
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
                    const mode = getPluginMode(pluginId);
                    // Re-register lazy commands on disable applies to both "lazy" and "lazyOnView" modes
                    const shouldReRegister =
                        settings.reRegisterLazyCommandsOnDisable ?? true;
                    if (
                        shouldReRegister &&
                        (mode === "lazy" || mode === "lazyOnView")
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
