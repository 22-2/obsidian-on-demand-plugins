import { Plugin } from "obsidian";
import { around } from "monkey-around";
import log from "loglevel";
import type { PluginContext } from "../core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/RibbonReorder");

type AddRibbonIcon = (this: Plugin, icon: string, title: string, callback: (evt: MouseEvent) => void) => HTMLElement;

export function patchRibbonReorder(ctx: PluginContext): void {
    if (typeof Plugin.prototype.addRibbonIcon !== "function") return;

    let warned = false;

    ctx.register(
        around(Plugin.prototype, {
            addRibbonIcon: (next: AddRibbonIcon) =>
                function (this: Plugin, ...args: Parameters<AddRibbonIcon>): ReturnType<AddRibbonIcon> {
                    const result = next.call(this, ...args) as HTMLElement;
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
