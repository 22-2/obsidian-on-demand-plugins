import { setTimeout as delay } from "node:timers/promises";
import { Plugin, type PluginManifest, type RibbonItem } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import { isPluginLoaded } from "src/core/utils";
import { RibbonLazyLoader } from "src/features/lazy-engine/ribbon/ribbon-lazy-loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/storage", () => ({ loadLocalStorage: vi.fn(), saveLocalStorage: vi.fn() }));
vi.mock("src/core/utils", () => ({ isPluginLoaded: vi.fn() }));

describe("RibbonLazyLoader", () => {
    const manifest = { id: "sample", version: "1.0.0" } as PluginManifest;
    const id = "sample:Open";
    let items: RibbonItem[];
    let ctx: PluginContext;
    let service: RibbonLazyLoader;
    let cleanup: (() => void)[];
    let loaded: boolean;
    let useRibbon: boolean;
    let mode: string;
    let ready: () => void;
    let original: PropertyDescriptor | undefined;
    const updateRibbonDisplay = vi.fn();
    const ensurePluginLoaded = vi.fn();

    function addItem(itemId: string, icon: string, title: string, callback: (evt: MouseEvent) => unknown) {
        const buttonEl = {} as HTMLElement;
        items.push({ id: itemId, icon, title, callback, buttonEl, hidden: false });
        return buttonEl;
    }

    function realPlugin() {
        const plugin = Object.create(Plugin.prototype) as Plugin;
        plugin.manifest = manifest;
        return plugin;
    }

    beforeEach(() => {
        vi.resetAllMocks();
        original = Object.getOwnPropertyDescriptor(Plugin.prototype, "addRibbonIcon");
        Plugin.prototype.addRibbonIcon = function (icon, title, callback) {
            return addItem(`${this.manifest.id}:${title}`, icon, title, callback);
        };
        items = [];
        cleanup = [];
        loaded = false;
        useRibbon = true;
        mode = "lazy";
        vi.mocked(isPluginLoaded).mockImplementation(() => loaded);
        vi.mocked(loadLocalStorage).mockReturnValue({ sample: { version: "1.0.0", items: [{ id, icon: "star", title: "Open" }] } });
        ctx = {
            app: {
                workspace: {
                    leftRibbon: {
                        get items() {
                            return items;
                        },
                        addRibbonItemButton: vi.fn(addItem),
                        removeRibbonAction: vi.fn((id: string) => {
                            items = items.filter((item) => item.id !== id);
                        }),
                    },
                    onLayoutReady: (fn: () => void) => {
                        ready = fn;
                    },
                },
                updateRibbonDisplay,
            },
            obsidianPlugins: {
                disablePlugin: vi.fn(() => {
                    loaded = false;
                    items = [];
                    return Promise.resolve();
                }),
            },
            getSettings: () => ({ plugins: { sample: { lazyOptions: { useRibbon } } } }),
            getPluginMode: () => mode,
            getManifests: () => [manifest],
            register: (fn: () => void) => cleanup.push(fn),
        } as unknown as PluginContext;
        service = new RibbonLazyLoader(ctx, { ensurePluginLoaded });
        service.register();
    });

    afterEach(() => {
        cleanup.reverse().forEach((fn) => fn());
        if (original) Object.defineProperty(Plugin.prototype, "addRibbonIcon", original);
        else Reflect.deleteProperty(Plugin.prototype, "addRibbonIcon");
    });

    it("renders at layout ready without loading, using the original identity and display rules", () => {
        expect(items).toHaveLength(0);
        ready();
        expect(items.map((item) => item.id)).toEqual([id]);
        expect(ensurePluginLoaded).not.toHaveBeenCalled();
        expect(updateRibbonDisplay).toHaveBeenCalled();
        service.sync();
        expect(items).toHaveLength(1);
    });

    it("loads and invokes the fresh callback on the first click with the original event", async () => {
        ready();
        const callback = vi.fn();
        const event = { ctrlKey: true, button: 1 } as MouseEvent;
        ensurePluginLoaded.mockImplementation(() => {
            loaded = true;
            realPlugin().addRibbonIcon("star", "Open", callback);
            return Promise.resolve(true);
        });
        const placeholder = items[0];
        placeholder.callback(event);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(event));
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(expect.objectContaining({ callback }));
        expect(ensurePluginLoaded).toHaveBeenCalledWith("sample");
    });

    it("waits for icons registered after async onload completes", async () => {
        ready();
        const callback = vi.fn();
        const plugin = realPlugin();
        ensurePluginLoaded.mockImplementation(() => {
            loaded = true;
            void delay(25).then(() => plugin.addRibbonIcon("star", "Open", callback));
            return Promise.resolve(true);
        });
        items[0].callback({} as MouseEvent);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
        expect(items).toHaveLength(1);
    });

    it("keeps the placeholder usable after a load failure", async () => {
        ready();
        ensurePluginLoaded.mockResolvedValue(false);
        const placeholder = items[0];
        placeholder.callback({} as MouseEvent);
        await vi.waitFor(() => expect(ensurePluginLoaded).toHaveBeenCalledTimes(1));
        expect(items[0]).toBe(placeholder);
        const callback = vi.fn();
        ensurePluginLoaded.mockImplementation(() => {
            loaded = true;
            realPlugin().addRibbonIcon("star", "Open", callback);
            return Promise.resolve(true);
        });
        placeholder.callback({} as MouseEvent);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    });

    it("captures multiple icons and restores them when the plugin is disabled", async () => {
        loaded = true;
        const plugin = realPlugin();
        plugin.addRibbonIcon("star", "Open", vi.fn());
        plugin.addRibbonIcon("gear", "Settings", vi.fn());
        expect(saveLocalStorage).toHaveBeenLastCalledWith(ctx.app, "ribbonCache", {
            sample: {
                version: "1.0.0",
                items: [
                    { id, icon: "star", title: "Open" },
                    { id: "sample:Settings", icon: "gear", title: "Settings" },
                ],
            },
        });
        await ctx.obsidianPlugins.disablePlugin("sample");
        expect(items.map((item) => item.title)).toEqual(["Open", "Settings"]);
    });

    it("replaces the cache on a new plugin instance instead of accumulating removed icons", () => {
        const first = realPlugin();
        first.addRibbonIcon("star", "Open", vi.fn());
        first.addRibbonIcon("gear", "Removed", vi.fn());
        items = [];
        realPlugin().addRibbonIcon("star", "Open", vi.fn());
        ready();
        expect(items.map((item) => item.title)).toEqual(["Open"]);
    });

    it("does not render for stale cache, another mode, disabled option, or loaded plugin", () => {
        manifest.version = "2.0.0";
        ready();
        expect(items).toHaveLength(0);
        manifest.version = "1.0.0";
        mode = "alwaysDisabled";
        service.sync();
        expect(items).toHaveLength(0);
        mode = "lazy";
        useRibbon = false;
        service.sync();
        expect(items).toHaveLength(0);
        useRibbon = true;
        loaded = true;
        service.sync();
        expect(items).toHaveLength(0);
    });

    it("clears previous metadata before recapturing a plugin that now has no icons", () => {
        service.resetCapture("sample");
        ready();
        expect(items).toHaveLength(0);
        expect(service.hasCaptured("sample")).toBe(false);
    });

    it("removes placeholders on unload and ignores late layout readiness", () => {
        ready();
        service.clear();
        expect(items).toHaveLength(0);
        ready();
        expect(items).toHaveLength(0);
    });
});
