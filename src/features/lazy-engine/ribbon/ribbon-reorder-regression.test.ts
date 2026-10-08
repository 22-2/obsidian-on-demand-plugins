import log from "loglevel";
import { Plugin, type PluginManifest } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { loadLocalStorage } from "src/core/storage";
import { isPluginLoaded } from "src/core/utils";
import { RibbonLazyLoader } from "src/features/lazy-engine/ribbon/ribbon-lazy-loader";
import { patchRibbonReorder } from "src/patches/ribbon-reorder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/storage", () => ({ loadLocalStorage: vi.fn(), saveLocalStorage: vi.fn() }));
vi.mock("src/core/utils", () => ({ isPluginLoaded: vi.fn() }));

type Button = { remove: () => void; visible: boolean; attached: boolean };
type Item = { id: string; icon: string; title: string; hidden: boolean; buttonEl?: Button; callback?: (evt: MouseEvent) => unknown };

/**
 * PR #2 compatibility with both patches installed in production order.
 * Model the native ribbon lifecycle (verified against Obsidian 1.13.7):
 * addRibbonItemButton reuses saved entries and onChange applies order/visibility;
 * removeRibbonAction clears runtime fields, retaining saved entries AND DOM.
 */
describe("ribbon order and hidden-state regression (PR #2)", () => {
    const manifest = { id: "sample", version: "1.0.0" } as PluginManifest;
    const entries = [
        { id: "sample:First", icon: "star", title: "First" },
        { id: "sample:Hidden", icon: "eye-off", title: "Hidden" },
        { id: "sample:Last", icon: "gear", title: "Last" },
    ];
    let items: Item[];
    let dom: Button[];
    let cleanup: (() => void)[];
    let original: PropertyDescriptor | undefined;
    let ctx: PluginContext;
    let service: RibbonLazyLoader;
    let loaded: boolean;
    let useRibbon: boolean;
    let mode: string;
    const updateRibbonDisplay = vi.fn();
    const ensurePluginLoaded = vi.fn();

    function onChange() {
        dom.forEach((button) => {
            button.attached = false;
        });
        dom = items.flatMap((item) => {
            if (!item.buttonEl) return [];
            item.buttonEl.visible = !item.hidden;
            item.buttonEl.attached = true;
            return [item.buttonEl];
        });
    }

    function addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => unknown) {
        const remove = vi.fn<() => void>();
        const button: Button = { remove, visible: true, attached: true };
        remove.mockImplementation(() => {
            button.attached = false;
            dom = dom.filter((el) => el !== button);
        });
        let item = items.find((item) => item.id === id);
        if (!item) {
            item = { id, icon, title, hidden: false };
            items.push(item);
        }
        Object.assign(item, { icon, title, callback, buttonEl: button });
        onChange();
        return button as unknown as HTMLElement;
    }

    function removeRibbonAction(id: string) {
        const item = items.find((item) => item.id === id);
        if (!item) return;
        delete item.buttonEl;
        delete item.callback;
    }

    function pluginInstance() {
        const plugin = Object.create(Plugin.prototype) as Plugin;
        plugin.manifest = manifest;
        return plugin;
    }

    function registerRealIcons(callback = vi.fn()) {
        const plugin = pluginInstance();
        // Intentionally opposite to the saved order.
        return entries.map((entry) => plugin.addRibbonIcon(entry.icon, entry.title, callback));
    }

    function savedState() {
        return items.map(({ id, hidden }) => ({ id, hidden }));
    }

    function visibleOrder() {
        return items.filter((item) => item.buttonEl?.attached && item.buttonEl.visible).map((item) => item.id);
    }

    beforeEach(() => {
        vi.resetAllMocks();
        cleanup = [];
        loaded = false;
        useRibbon = true;
        mode = "lazy";
        dom = [];
        // Restored layout includes inactive entries, in the user's custom order.
        items = [entries[2], entries[1], entries[0]].map((entry) => ({ ...entry, hidden: entry.title === "Hidden" }));
        original = Object.getOwnPropertyDescriptor(Plugin.prototype, "addRibbonIcon");
        Plugin.prototype.addRibbonIcon = function (icon, title, callback) {
            return addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
        };
        vi.mocked(isPluginLoaded).mockImplementation(() => loaded);
        vi.mocked(loadLocalStorage).mockReturnValue({ sample: { version: manifest.version, items: entries } });
        ctx = {
            app: {
                workspace: { leftRibbon: { items, addRibbonItemButton, removeRibbonAction }, onLayoutReady: () => {} },
                updateRibbonDisplay,
            },
            obsidianPlugins: {
                disablePlugin: async () => {
                    for (const item of items) {
                        const button = item.buttonEl;
                        removeRibbonAction(item.id);
                        button?.remove();
                    }
                    loaded = false;
                },
            },
            getSettings: () => ({ plugins: { sample: { lazyOptions: { useRibbon } } } }),
            getPluginMode: () => mode,
            getManifests: () => [manifest],
            register: (fn: () => void) => cleanup.push(fn),
        } as unknown as PluginContext;
        // Same order as LazyEngineFeature.onload.
        patchRibbonReorder(ctx);
        service = new RibbonLazyLoader(ctx, { ensurePluginLoaded });
        service.register();
    });

    afterEach(() => {
        cleanup.reverse().forEach((fn) => fn());
        if (original) Object.defineProperty(Plugin.prototype, "addRibbonIcon", original);
        else Reflect.deleteProperty(Plugin.prototype, "addRibbonIcon");
        vi.restoreAllMocks();
    });

    it("restores placeholders over inactive saved entries without changing order or hidden state", () => {
        const before = savedState();
        service.sync();
        expect(dom).toHaveLength(3);
        expect(visibleOrder()).toEqual(["sample:Last", "sample:First"]);
        expect(items[1].buttonEl?.visible).toBe(false);
        expect(savedState()).toEqual(before);
        expect(ensurePluginLoaded).not.toHaveBeenCalled();
        expect(updateRibbonDisplay).toHaveBeenCalledTimes(1);
    });

    it("preserves state through first-click replacement and repeated disable/load cycles", async () => {
        const before = savedState();
        service.sync();
        const placeholders = [...dom];
        const callback = vi.fn();
        const event = { ctrlKey: true } as MouseEvent;
        ensurePluginLoaded.mockImplementation(() => {
            loaded = true;
            registerRealIcons(callback);
            return Promise.resolve(true);
        });
        items[2].callback?.(event);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(event));
        expect(placeholders.every((button) => !button.attached)).toBe(true);
        expect(dom).toHaveLength(3);
        expect(visibleOrder()).toEqual(["sample:Last", "sample:First"]);
        expect(savedState()).toEqual(before);
        // Existing PR #2 patch still executes after EACH real icon registration.
        expect(updateRibbonDisplay).toHaveBeenCalledTimes(4);
        for (let cycle = 0; cycle < 2; cycle++) {
            await ctx.obsidianPlugins.disablePlugin("sample");
            expect(dom).toHaveLength(3);
            expect(visibleOrder()).toEqual(["sample:Last", "sample:First"]);
            items[2].callback?.(event);
            await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(cycle + 2));
            expect(dom).toHaveLength(3);
            expect(savedState()).toEqual(before);
        }
    });

    it.each([false, true])("keeps PR #2 active for direct/command loads with useRibbon=%s", (enabled) => {
        useRibbon = enabled;
        const before = savedState();
        loaded = true;
        const returned = registerRealIcons();
        expect(visibleOrder()).toEqual(["sample:Last", "sample:First"]);
        expect(savedState()).toEqual(before);
        expect(updateRibbonDisplay).toHaveBeenCalledTimes(3);
        expect(returned[0]).toBe(items[2].buttonEl);
    });

    it("detaches all placeholder DOM on unload and leaves saved preferences intact", () => {
        const before = savedState();
        service.sync();
        const placeholders = [...dom];
        service.clear();
        expect(dom).toHaveLength(0);
        expect(placeholders.every((button) => !button.attached)).toBe(true);
        expect(savedState()).toEqual(before);
        expect(items.every((item) => !item.buttonEl && !item.callback)).toBe(true);
    });

    it("detaches new placeholders when there were no saved entries yet", () => {
        items.splice(0);
        service.sync();
        const before = savedState();
        const placeholders = [...dom];
        expect(placeholders).toHaveLength(3);
        service.clear();
        expect(dom).toHaveLength(0);
        expect(placeholders.every((button) => !button.attached)).toBe(true);
        expect(savedState()).toEqual(before);
    });

    it("does not unregister a live icon that took over a placeholder ID", () => {
        items.splice(0);
        service.sync();
        const callback = vi.fn();
        addRibbonItemButton(entries[0].id, "star", "First", callback);
        const item = items.find((item) => item.id === entries[0].id)!;
        const button = item.buttonEl;
        mode = "alwaysEnabled";
        service.syncPlugin("sample");
        expect(item.buttonEl).toBe(button);
        expect(item.callback).toBe(callback);
        expect(button?.attached).toBe(true);
        expect(dom).toHaveLength(1);
    });

    it("keeps PR #2 exception isolation when the two patches are composed", () => {
        const error = new Error("display failed");
        updateRibbonDisplay.mockImplementation(() => {
            throw error;
        });
        const warn = vi.spyOn(log.getLogger("OnDemandPlugin/RibbonReorder"), "warn").mockImplementation(() => {});
        const plugin = pluginInstance();
        const returned = plugin.addRibbonIcon("star", "First", vi.fn());
        expect(returned).toBe(items[2].buttonEl);
        expect(warn).toHaveBeenCalledWith("updateRibbonDisplay failed:", error);
    });
});
