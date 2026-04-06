import log from "loglevel";
import { around } from "monkey-around";
import { Plugin } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/RibbonReorder");

type AddRibbonIcon = (this: Plugin, icon: string, title: string, callback: (evt: MouseEvent) => void) => HTMLElement;
// ── Patch ────────────────────────────────────────────────────────────────────

/**
 * Fixes random ribbon icon order and prevents hidden icons from
 * reappearing for lazy-loaded plugins.
 *
 * Related: https://github.com/22-2/obsidian-on-demand-plugins/issues/1
 */
export function patchRibbonReorder(ctx: PluginContext): void {
    if (typeof Plugin.prototype.addRibbonIcon !== "function") return;

    ctx.register(
        around(Plugin.prototype, {
            addRibbonIcon: (next: AddRibbonIcon) =>
                function (this: Plugin, ...args: Parameters<AddRibbonIcon>): ReturnType<AddRibbonIcon> {
                    const result = next.call(this, ...args);
                    try {
                        ctx.app.updateRibbonDisplay();
                    } catch (error) {
                        // Intentionally log every failure so repeated instability remains visible.
                        logger.warn("updateRibbonDisplay failed:", error);
                    }
                    return result;
                },
        }),
    );
}
