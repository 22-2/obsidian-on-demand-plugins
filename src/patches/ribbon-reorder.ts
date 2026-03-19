import { Plugin } from "obsidian";
import { around } from "monkey-around";
import log from "loglevel";
import type { PluginContext } from "../core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/RibbonReorder");

export function patchRibbonReorder(ctx: PluginContext): void {
    if (typeof Plugin.prototype.addRibbonIcon !== "function") return;

    let warned = false;

    ctx.register(
        around(Plugin.prototype, {
            addRibbonIcon: (next) =>
                function (this: Plugin, ...args: Parameters<Plugin["addRibbonIcon"]>) {
                    const result = next.call(this, ...args);
                    try {
                        if (typeof ctx.app.updateRibbonDisplay === "function") {
                            ctx.app.updateRibbonDisplay();
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
