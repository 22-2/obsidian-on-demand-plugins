import log from "loglevel";
import { around } from "monkey-around";
import type { ViewCreator } from "obsidian";
import { Plugin } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";

const logger = log.getLogger("OnDemandPlugin/ViewRegistryPatch");

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Return true if the given plugin is in LAZY mode with `useView` enabled.
 */
function isLazyWithUseView(ctx: PluginContext, pluginId: string): boolean {
    const settings = ctx.getSettings();
    const mode = ctx.getPluginMode(pluginId);
    const pluginSettings = settings.plugins[pluginId];
    return mode === PLUGIN_MODE.LAZY && pluginSettings?.lazyOptions?.useView === true;
}

/**
 * Register a view type in both the legacy lazyOnViews map and the per-plugin lazy options.
 *
 * @returns true when the view type was newly recorded in either map.
 */
function trackViewType(ctx: PluginContext, pluginId: string, viewType: string): boolean {
    let added = false;

    // The legacy map is still consulted when resolving which plugin owns an opened view.
    const settings = ctx.getSettings();
    settings.lazyOnViews ??= {};
    const lazyOnViews = settings.lazyOnViews;
    lazyOnViews[pluginId] ??= [];
    if (!lazyOnViews[pluginId].includes(viewType)) {
        lazyOnViews[pluginId].push(viewType);
        added = true;
    }

    // Persist to plugin settings so the view type survives restarts
    const pluginOptions = settings.plugins[pluginId]?.lazyOptions;
    if (pluginOptions) {
        // Initialize the viewTypes array if it doesn't exist, then add the new view type
        pluginOptions.viewTypes ??= [];
        if (!pluginOptions.viewTypes.includes(viewType)) {
            pluginOptions.viewTypes.push(viewType);
            added = true;
        }
    }

    return added;
}

// ── Patch ────────────────────────────────────────────────────────────────────

/**
 * Patch Plugin.prototype.registerView to attribute view types to the owning
 * plugin instance via `this.manifest.id`.
 *
 * Why the public Plugin method instead of the internal ViewRegistry:
 * Obsidian's `loadingPluginId` is cleared as soon as the synchronous part of
 * onload returns, so a plugin that calls registerView after an `await` in
 * onload or inside an onLayoutReady callback (e.g. graph-analysis) cannot be
 * attributed at the ViewRegistry level. The Plugin method receives the
 * plugin instance as `this`, which identifies the caller regardless of
 * timing, and does not depend on Obsidian internals. This patch stays
 * installed for the whole session and captures view types whenever a lazy
 * plugin happens to load (startup-policy apply, command-cache rebuild, or an
 * actual lazy load).
 */
export function patchPluginRegisterView(ctx: PluginContext): () => void {
    return around(Plugin.prototype, {
        registerView: (next) =>
            function (this: Plugin, type: string, viewCreator: ViewCreator) {
                // Keep registerView behavior intact even if lazy tracking fails.
                try {
                    const pluginId = this.manifest?.id;
                    if (pluginId && type && isLazyWithUseView(ctx, pluginId)) {
                        if (trackViewType(ctx, pluginId, type)) {
                            logger.debug(`registerView: attributed view type "${type}" to ${pluginId}`);
                            // Persist immediately: lazy plugins get disabled right after
                            // their capture windows (apply / cache rebuild), so deferring
                            // the save risks losing the only chance to record the mapping.
                            void ctx.saveSettings();
                        }
                    }
                } catch (error) {
                    logger.warn("registerView attribution failed:", error);
                }

                return next.call(this, type, viewCreator);
            },
    });
}
