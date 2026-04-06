import { Plugin } from "obsidian";
import { around } from "monkey-around";
import log from "loglevel";
import type { PluginContext } from "../core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/RibbonReorder");

type AddRibbonIcon = (this: Plugin, icon: string, title: string, callback: (evt: MouseEvent) => void) => HTMLElement;

export function patchRibbonReorder(ctx: PluginContext): void {
    if (typeof Plugin.prototype.addRibbonIcon !== "function") return;

    ctx.register(
        around(Plugin.prototype, {
            addRibbonIcon: (next: AddRibbonIcon) =>
                function (this: Plugin, ...args: Parameters<AddRibbonIcon>): ReturnType<AddRibbonIcon> {
                    const result = next.call(this, ...args) as HTMLElement;
                    try {
                        if (typeof ctx.app.updateRibbonDisplay === "function") {
                            ctx.app.updateRibbonDisplay();
                        }
                    } catch (error) {
                        // Intentionally log every failure so repeated instability remains visible.
                        logger.warn("updateRibbonDisplay failed:", error);
                    }
                    return result;
                },
        }),
    );
}
