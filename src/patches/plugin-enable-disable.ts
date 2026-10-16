import type { Plugins } from "@obsidian-typings/obsidian-public-latest";
import log from "loglevel";
import { around } from "monkey-around";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";

const logger = log.getLogger("OnDemandPlugin/PluginEnableDisablePatch");

/**
 * Operations the patch needs from the lazy engine. Passed in by the installer so
 * the patch layer never reaches up into features or the plugin instance.
 */
export interface EnableDisableHooks {
    /** Save a user-chosen mode for a plugin and apply it. */
    setPluginMode(pluginId: string, mode: PLUGIN_MODE): Promise<void>;
    /** Re-sync the lazy command wrappers to the plugin's live load state. */
    syncCommandWrappers(pluginId: string): void;
}

// ── Helpers ─────────────────────────────────────────

/**
 * Update plugin mode only when it matches the expected `fromMode`.
 * Preserves LAZY mode on both enable and disable paths.
 */
export async function syncPluginMode(ctx: PluginContext, hooks: EnableDisableHooks, pluginId: string, fromMode: PLUGIN_MODE, toMode: PLUGIN_MODE): Promise<void> {
    const mode = ctx.getPluginMode(pluginId);
    if (mode === fromMode) {
        await hooks.setPluginMode(pluginId, toMode);
    }
}

/**
 * Run the post-toggle sync steps after enable or disable, catching all errors
 * so Obsidian's core flow is never interrupted.
 */
export async function runPostToggleSync(ctx: PluginContext, hooks: EnableDisableHooks, pluginId: string, fromMode: PLUGIN_MODE, toMode: PLUGIN_MODE, label: "enablePlugin" | "disablePlugin", isUserToggle = true): Promise<void> {
    try {
        if (isUserToggle) await syncPluginMode(ctx, hooks, pluginId, fromMode, toMode);
        // Wrappers follow the live load state, so they are re-synced after every toggle.
        hooks.syncCommandWrappers(pluginId);
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
 *
 * Only calls flagged as user toggles change the saved mode. Obsidian passes the flag from
 * `enablePluginAndSave` / `disablePluginAndSave` (the settings toggle, its CLI and
 * other plugins persisting a toggle), but not from restricted mode, `plugin:reload`,
 * lazy loads or the in-memory toggles, none of which change community-plugins.json.
 */
export function patchPluginEnableDisable(ctx: PluginContext, hooks: EnableDisableHooks): void {
    const obsidianPlugins = ctx.obsidianPlugins;

    ctx.register(
        around(obsidianPlugins, {
            enablePlugin: (next: Plugins["enablePlugin"]) =>
                async function (this: Plugins, pluginId: string, isUserEnabled?: boolean) {
                    const result = await next.call(this, pluginId, isUserEnabled);
                    // Only sync ALWAYS_DISABLED → ALWAYS_ENABLED; preserve LAZY mode.
                    await runPostToggleSync(ctx, hooks, pluginId, PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.ALWAYS_ENABLED, "enablePlugin", isUserEnabled === true);
                    return result;
                },

            disablePlugin: (next: Plugins["disablePlugin"]) =>
                async function (this: Plugins, pluginId: string, isUserDisabled?: boolean) {
                    const result = await next.call(this, pluginId, isUserDisabled);
                    // Only sync ALWAYS_ENABLED → ALWAYS_DISABLED; preserve LAZY mode.
                    await runPostToggleSync(ctx, hooks, pluginId, PLUGIN_MODE.ALWAYS_ENABLED, PLUGIN_MODE.ALWAYS_DISABLED, "disablePlugin", isUserDisabled === true);
                    return result;
                },
        }),
    );
}
