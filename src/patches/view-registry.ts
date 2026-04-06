import { around } from "monkey-around";
import type { PluginContext } from "../core/plugin-context";
import { PLUGIN_MODE } from "../core/types";
import type { ViewRegistry } from "obsidian-typings";

/**
 * Return true if the given plugin is in LAZY mode with `useView` enabled.
 */
function isLazyWithUseView(ctx: PluginContext, pluginId: string): boolean {
    const settings = ctx.getSettings();
    const mode = ctx.getPluginMode(pluginId);
    const pluginSettings = settings.plugins[pluginId];
    return (
        mode === PLUGIN_MODE.LAZY &&
        pluginSettings?.lazyOptions?.useView === true
    );
}

/**
 * Register a view type.
 * Updates both the runtime map and the persisted plugin settings.
 */
function trackViewType(
    ctx: PluginContext,
    pluginId: string,
    viewType: string,
    lazyOnViews: Record<string, string[]>
): void {
    // Update the in-memory map used at runtime.
    // This map is used to resolve which plugin should be loaded when a view is opened.
    lazyOnViews[pluginId] ??= [];
    if (!lazyOnViews[pluginId].includes(viewType)) {
        lazyOnViews[pluginId].push(viewType);
    }

    // Persist to plugin settings so the view type survives restarts
    const pluginOptions = ctx.getSettings().plugins[pluginId]?.lazyOptions;
    if (pluginOptions) {
        // Initialize the viewTypes array if it doesn't exist, then add the new view type
        pluginOptions.viewTypes ??= [];
        if (!pluginOptions.viewTypes.includes(viewType)) {
            pluginOptions.viewTypes.push(viewType);
        }
    }
}

// ── Patch ────────────────────────────────────────────────────────────────────

/**
 * Patch ViewRegistry.registerView to capture which view types each lazy plugin registers.
 * Returns a cleanup function to undo the monkey-patch.
 */
export function patchViewRegistry(
    ctx: PluginContext,
    lazyOnViews: Record<string, string[]>
): () => void {
    return around(ctx.app.viewRegistry, {
        registerView: (next) =>
            function (this: ViewRegistry, type, creator) {
                const loadingId = ctx.app.plugins.loadingPluginId as string | undefined;

                if (loadingId && type && isLazyWithUseView(ctx, loadingId)) {
                    trackViewType(ctx, loadingId, type, lazyOnViews);
                }

                return next.call(this, type, creator);
            },
    });
}
