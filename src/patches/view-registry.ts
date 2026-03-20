import { around } from "monkey-around";
import type { Plugins } from "obsidian-typings";
import type { PluginContext } from "../core/plugin-context";
import { PLUGIN_MODE } from "../core/types";

/**
 * Patch ViewRegistry.registerView to capture which view types each lazy plugin registers.
 * Returns a cleanup function to undo the monkey-patch.
 */
export function patchViewRegistry(
    ctx: PluginContext,
    lazyOnViews: Record<string, string[]>
): () => void {
    const { viewRegistry } = ctx.app as unknown as {
        viewRegistry?: { registerView?: (type: string, creator: unknown) => unknown };
    };

    if (!viewRegistry || typeof viewRegistry.registerView !== "function") {
        return () => {};
    }

    const settings = ctx.getSettings();
    type RegisterView = NonNullable<NonNullable<typeof viewRegistry>["registerView"]>;

    return around(viewRegistry as Required<typeof viewRegistry>, {
        registerView: (next: RegisterView) =>
            function (this: unknown, type: string, creator: unknown): unknown {
                const loadingId = (ctx.app as unknown as { plugins: Plugins }).plugins.loadingPluginId as string | undefined;

                if (loadingId && type) {
                    const mode = ctx.getPluginMode(loadingId);
                    const pluginSettings = settings.plugins[loadingId];
                    const isLazyWithUseView = mode === PLUGIN_MODE.LAZY && pluginSettings?.lazyOptions?.useView === true;

                    if (isLazyWithUseView) {
                        lazyOnViews[loadingId] ??= [];
                        if (!lazyOnViews[loadingId].includes(type)) {
                            lazyOnViews[loadingId].push(type);
                        }

                        if (pluginSettings?.lazyOptions) {
                            pluginSettings.lazyOptions.viewTypes ??= [];
                            if (!pluginSettings.lazyOptions.viewTypes.includes(type)) {
                                pluginSettings.lazyOptions.viewTypes.push(type);
                            }
                        }
                    }
                }

                const result: ReturnType<RegisterView> = next.call(this, type, creator);
                return result;
            },
    });
}
