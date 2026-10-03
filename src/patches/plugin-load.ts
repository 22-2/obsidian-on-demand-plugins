import type { Plugins } from "@obsidian-typings/obsidian-public-latest";
import { around } from "monkey-around";

/** Share in-flight loads with CLI reloads and other callers of Obsidian's loader. */
export function patchPluginLoad(plugins: Plugins): () => void {
    const pending = new Map<string, ReturnType<Plugins["loadPlugin"]>>();

    return around(plugins, {
        loadPlugin: (next) =>
            function (this: Plugins, ...args: Parameters<Plugins["loadPlugin"]>) {
                const [pluginId] = args;
                const existing = pending.get(pluginId);
                if (existing) return existing;

                // Obsidian checks its instance map before awaiting the script read.
                // A CLI reload and a lazy trigger can both pass that check and then
                // create instances that register the same view. Guard the shared
                // loader, since the lazy runner's mutex cannot cover external calls.
                const loading = Promise.resolve()
                    .then(() => next.apply(this, args))
                    .finally(() => pending.delete(pluginId));
                pending.set(pluginId, loading);
                return loading;
            },
    });
}
