import { Plugin } from "obsidian";
import { around } from "monkey-around";
import log from "loglevel";
import type { PluginContext } from "../core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/RibbonReorder");

export function patchRibbonReorder(ctx: PluginContext): void {
    if (typeof Plugin.prototype.addRibbonIcon !== "function") return;

    let warned = false;

    ctx.register(
        around(Plugin.prototype as any, {
            addRibbonIcon: (next: any) =>
                function (this: any, ...args: any[]) {
                    const result = next.call(this, ...args);
                    try {
                        if (typeof (ctx.app as any).updateRibbonDisplay === "function") {
                            (ctx.app as any).updateRibbonDisplay();
                        }
                    } catch (e) {
                        if (!warned) {
                            logger.warn("updateRibbonDisplay failed:", e);
                            warned = true;
                        }
                    }
                    return result;
                },
        }),
    );
}
