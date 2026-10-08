import log from "loglevel";
import { around } from "monkey-around";
import { Notice, Plugin } from "obsidian";
import pWaitFor from "p-wait-for";
import type { PluginContext } from "src/core/plugin-context";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import { PLUGIN_MODE } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import type { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";

type CachedRibbon = { id: string; icon: string; title: string };
type RibbonCache = Record<string, { version: string; items: CachedRibbon[] }>;
const logger = log.getLogger("OnDemandPlugin/RibbonLazyLoader");

/** Cache metadata only; execute callbacks from the newly loaded plugin instance. */
export class RibbonLazyLoader {
    private ctx: PluginContext;
    private loader: Pick<LazyCommandRunner, "ensurePluginLoaded">;
    private cache: RibbonCache;
    private placeholders = new Map<string, Map<string, HTMLElement>>();
    private captures = new WeakMap<Plugin, CachedRibbon[]>();
    private disposed = false;

    constructor(ctx: PluginContext, loader: Pick<LazyCommandRunner, "ensurePluginLoaded">) {
        this.ctx = ctx;
        this.loader = loader;
        this.cache = loadLocalStorage<RibbonCache>(ctx.app, "ribbonCache") ?? {};
    }

    register(): void {
        const removePlaceholders = this.removePlaceholders.bind(this);
        const capture = this.capture.bind(this);
        this.ctx.register(
            around(Plugin.prototype, {
                addRibbonIcon: (next: Plugin["addRibbonIcon"]) =>
                    function (this: Plugin, icon: string, title: string, callback: (evt: MouseEvent) => unknown) {
                        const pluginId = this.manifest.id;
                        // The real icons must take over their original IDs before registration.
                        try {
                            removePlaceholders(pluginId);
                        } catch (error) {
                            logger.warn("Failed to remove cached ribbon icons", pluginId, error);
                        }
                        const result = next.call(this, icon, title, callback);
                        capture(this, icon, title, result);
                        return result;
                    },
            }),
        );
        this.ctx.register(
            around(this.ctx.obsidianPlugins, {
                disablePlugin: (next) => async (pluginId: string) => {
                    await next.call(this.ctx.obsidianPlugins, pluginId);
                    try {
                        this.syncPlugin(pluginId);
                    } catch (error) {
                        logger.warn("Failed to restore cached ribbon icons", pluginId, error);
                    }
                },
            }),
        );
        this.ctx.app.workspace.onLayoutReady(() => {
            if (!this.disposed) this.sync();
        });
        this.ctx.register(() => this.clear());
    }

    private capture(plugin: Plugin, icon: string, title: string, buttonEl: HTMLElement): void {
        const pluginId = plugin.manifest.id;
        try {
            if (!this.isEnabled(pluginId)) return;
            const item = this.ctx.app.workspace.leftRibbon.items.find((item) => item.buttonEl === buttonEl);
            if (!item) return;
            let items = this.captures.get(plugin);
            if (!items) {
                items = [];
                this.captures.set(plugin, items);
            }
            const entry = { id: item.id, icon, title };
            const index = items.findIndex((cached) => cached.id === item.id);
            if (index < 0) items.push(entry);
            else items[index] = entry;
            this.cache[pluginId] = { version: plugin.manifest.version, items };
            this.persist();
        } catch (error) {
            logger.warn("Failed to capture ribbon icon", pluginId, error);
        }
    }

    isEnabled(pluginId: string): boolean {
        return this.ctx.getPluginMode(pluginId) === PLUGIN_MODE.LAZY && this.ctx.getSettings().plugins[pluginId]?.lazyOptions?.useRibbon === true;
    }

    /** Apply reloads configured plugins so icons can be captured even with a valid command cache. */
    hasCaptured(pluginId: string): boolean {
        const manifest = this.ctx.getManifests().find((manifest) => manifest.id === pluginId);
        return this.cache[pluginId]?.version === manifest?.version && (this.cache[pluginId]?.items.length ?? 0) > 0;
    }

    resetCapture(pluginId: string): void {
        delete this.cache[pluginId];
        this.persist();
    }

    sync(): void {
        for (const pluginId of this.placeholders.keys()) this.removePlaceholders(pluginId);
        for (const manifest of this.ctx.getManifests()) this.syncPlugin(manifest.id);
    }

    syncPlugin(pluginId: string): void {
        this.removePlaceholders(pluginId);
        if (this.disposed || !this.isEnabled(pluginId) || isPluginLoaded(this.ctx.app, pluginId) || !this.hasCaptured(pluginId)) return;
        const ribbon = this.ctx.app.workspace.leftRibbon;
        const buttons = new Map<string, HTMLElement>();
        this.placeholders.set(pluginId, buttons);
        for (const item of this.cache[pluginId].items) {
            // Obsidian retains inactive entries to preserve order and hidden state.
            if (ribbon.items.some((real) => real.id === item.id && real.buttonEl)) continue;
            const button = ribbon.addRibbonItemButton(item.id, item.icon, item.title, (evt) => {
                void this.activate(pluginId, item.id, evt);
            });
            buttons.set(item.id, button);
        }
        this.ctx.app.updateRibbonDisplay();
    }

    private async activate(pluginId: string, itemId: string, evt: MouseEvent): Promise<void> {
        if (this.disposed || !this.isEnabled(pluginId)) return;
        try {
            if (!(await this.loader.ensurePluginLoaded(pluginId))) {
                new Notice(`Failed to load plugin: ${pluginId}`);
                return;
            }
            // async onload may register icons after Obsidian marks the plugin loaded.
            await pWaitFor(() => this.disposed || !!this.getRealItem(pluginId, itemId), { interval: 50, timeout: 8000 });
            if (this.disposed) return;
            const item = this.getRealItem(pluginId, itemId);
            if (item) await item.callback(evt);
        } catch (error) {
            logger.warn("Failed to activate ribbon icon", pluginId, itemId, error);
            new Notice(`Ribbon action not available: ${pluginId}. Try applying changes again.`);
        }
    }

    private getRealItem(pluginId: string, itemId: string) {
        if (this.placeholders.get(pluginId)?.has(itemId)) return undefined;
        return this.ctx.app.workspace.leftRibbon.items.find((item) => item.id === itemId && item.buttonEl && typeof item.callback === "function");
    }

    private removePlaceholders(pluginId: string): void {
        const buttons = this.placeholders.get(pluginId);
        if (!buttons) return;
        const ribbon = this.ctx.app.workspace.leftRibbon;
        for (const [id, button] of buttons) {
            // Do not unregister a real icon that has already taken over this ID.
            if (ribbon.items.find((item) => item.id === id)?.buttonEl === button) {
                ribbon.removeRibbonAction(id);
            }
            // removeRibbonAction only clears runtime references; it does not detach DOM.
            button.remove();
        }
        this.placeholders.delete(pluginId);
    }

    private persist(): void {
        saveLocalStorage(this.ctx.app, "ribbonCache", this.cache);
    }

    clear(): void {
        this.disposed = true;
        for (const pluginId of this.placeholders.keys()) this.removePlaceholders(pluginId);
    }
}
