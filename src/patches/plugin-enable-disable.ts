import { around } from "monkey-around";
import type { Plugins } from "obsidian-typings";
import type { PluginContext } from "../core/plugin-context";
import type { CommandCacheService } from "../services/command-cache/command-cache-service";

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
export function patchPluginEnableDisable(
    ctx: PluginContext,
    commandCacheService: CommandCacheService,
): void {
    const obsidianPlugins = ctx.obsidianPlugins as unknown as Plugins;

    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);

                    const mode = ctx.getPluginMode(pluginId);
                    const data = ctx.getData();

                    if (data.showConsoleLog) {
                        console.log(
                            `[LazyPlugins] enablePlugin patch: id=${pluginId}, mode=${mode}`,
                        );
                    }

                    // Sync settings: disabled → keepEnabled
                    if (mode === "disabled") {
                        const settings = ctx.getSettings();
                        settings.plugins[pluginId] = {
                            mode: "keepEnabled",
                            userConfigured: true,
                        };
                        await ctx.saveSettings();

                        if (data.showConsoleLog) {
                            console.log(
                                `[LazyPlugins] Synced settings: ${pluginId} disabled → keepEnabled`,
                            );
                        }
                    }

                    commandCacheService.syncCommandWrappersForPlugin(pluginId);
                    return result;
                },
            disablePlugin: (next) =>
                async function (this: Plugins, pluginId: string) {
                    const result = await next.call(this, pluginId);

                    const mode = ctx.getPluginMode(pluginId);
                    const data = ctx.getData();

                    if (data.showConsoleLog) {
                        console.log(
                            `[LazyPlugins] disablePlugin patch: id=${pluginId}, mode=${mode}`,
                        );
                    }

                    // Sync settings: keepEnabled → disabled
                    if (mode === "keepEnabled") {
                        const settings = ctx.getSettings();
                        settings.plugins[pluginId] = {
                            mode: "disabled",
                            userConfigured: true,
                        };
                        await ctx.saveSettings();

                        if (data.showConsoleLog) {
                            console.log(
                                `[LazyPlugins] Synced settings: ${pluginId} keepEnabled → disabled`,
                            );
                        }
                    }

                    // For lazy modes: do nothing. The plugin was already in a
                    // disabled state; the lazy config is preserved and will be
                    // re-applied on next startup.

                    return result;
                },
        }),
    );
}
