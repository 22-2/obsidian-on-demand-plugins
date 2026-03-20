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
                    const callNext = next as (this: Plugin, ...innerArgs: Parameters<AddRibbonIcon>) => ReturnType<AddRibbonIcon>;
                    // `monkey-around` erases the original method signature to `any`.
                    // The explicit cast above narrows it back to the concrete runtime contract.
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    const result = callNext.call(this, ...args);
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
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                    return result;
                },
        }),
    );
}
