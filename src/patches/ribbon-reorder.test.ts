import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin } from "obsidian";
import log from "loglevel";
import { patchRibbonReorder } from "src/patches/ribbon-reorder";
import type { PluginContext } from "src/core/plugin-context";

describe("patchRibbonReorder", () => {
    let originalAddRibbonIcon: Plugin["addRibbonIcon"] | undefined;
    let unregister: () => void;

    beforeEach(() => {
        vi.resetAllMocks();
        originalAddRibbonIcon = undefined;
    });

    afterEach(() => {
        // Restore prototype if we modified it
        if (originalAddRibbonIcon !== undefined) {
            (Plugin.prototype as unknown as Record<string, unknown>).addRibbonIcon = originalAddRibbonIcon;
        } else {
            Reflect.deleteProperty(Plugin.prototype, "addRibbonIcon");
        }
    });

    function setupPrototype() {
        originalAddRibbonIcon = (Plugin.prototype as unknown as { addRibbonIcon?: Plugin["addRibbonIcon"] }).addRibbonIcon;
        (Plugin.prototype as unknown as Record<string, unknown>).addRibbonIcon = vi.fn().mockReturnValue({ tagName: "DIV" });
    }

    function createMockCtx(appOverrides: Record<string, unknown> = {}) {
        return {
            app: { updateRibbonDisplay: vi.fn(), ...appOverrides },
            register: (fn: () => void) => { unregister = fn; },
        } as unknown as PluginContext;
    }

    function createPluginInstance() {
        const plugin = Object.create(Plugin.prototype);
        plugin.manifest = { id: "test-plugin" };
        return plugin;
    }

    it("calls updateRibbonDisplay when addRibbonIcon is called", () => {
        setupPrototype();
        const ctx = createMockCtx();
        patchRibbonReorder(ctx);

        const plugin = createPluginInstance();
        plugin.addRibbonIcon("dice", "Test", vi.fn());

        expect(ctx.app.updateRibbonDisplay).toHaveBeenCalled();
    });

    it("preserves original addRibbonIcon return value", () => {
        setupPrototype();
        const expectedEl = { tagName: "SPAN" };
        (Plugin.prototype as unknown as Record<string, unknown>).addRibbonIcon = vi.fn().mockReturnValue(expectedEl);

        const ctx = createMockCtx();
        patchRibbonReorder(ctx);

        const plugin = createPluginInstance();
        const result = plugin.addRibbonIcon("dice", "Test", vi.fn());

        expect(result).toBe(expectedEl);
    });

    it("no-ops when updateRibbonDisplay is missing", () => {
        setupPrototype();
        const ctx = createMockCtx({ updateRibbonDisplay: undefined });
        delete (ctx.app as unknown as Record<string, unknown>).updateRibbonDisplay;
        patchRibbonReorder(ctx);

        const plugin = createPluginInstance();
        expect(() => plugin.addRibbonIcon("dice", "Test", vi.fn())).not.toThrow();
    });

    it("no-ops when addRibbonIcon is missing on prototype", () => {
        // Don't add addRibbonIcon to prototype
        originalAddRibbonIcon = (Plugin.prototype as unknown as { addRibbonIcon?: Plugin["addRibbonIcon"] }).addRibbonIcon;
        const ctx = createMockCtx();
        expect(() => patchRibbonReorder(ctx)).not.toThrow();
    });

    it("isolates updateRibbonDisplay exceptions and logs a warning every time", () => {
        setupPrototype();
        const expectedEl = { tagName: "DIV" };
        (Plugin.prototype as unknown as Record<string, unknown>).addRibbonIcon = vi.fn().mockReturnValue(expectedEl);

        const error = new Error("ribbon exploded");
        const ctx = createMockCtx({
            updateRibbonDisplay: vi.fn().mockImplementation(() => {
                throw error;
            }),
        });
        patchRibbonReorder(ctx);

        const logger = log.getLogger("OnDemandPlugin/RibbonReorder");
        const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const plugin = createPluginInstance();

        let result!: ReturnType<Plugin["addRibbonIcon"]>;
        expect(() => { result = plugin.addRibbonIcon("dice", "Test", vi.fn()); }).not.toThrow();
        expect(result).toBe(expectedEl);
        expect(warnSpy).toHaveBeenCalledWith("updateRibbonDisplay failed:", error);

        // Second call should also log so repeated failures remain visible.
        warnSpy.mockClear();
        expect(() => plugin.addRibbonIcon("dice", "Test2", vi.fn())).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith("updateRibbonDisplay failed:", error);

        warnSpy.mockRestore();
    });

    it("cleanup restores original method", () => {
        setupPrototype();
        const original = (Plugin.prototype as unknown as { addRibbonIcon?: Plugin["addRibbonIcon"] }).addRibbonIcon;
        const ctx = createMockCtx();
        patchRibbonReorder(ctx);

        // Method should be patched (different from original)
        expect((Plugin.prototype as unknown as { addRibbonIcon?: Plugin["addRibbonIcon"] }).addRibbonIcon).not.toBe(original);

        // Call unregister to restore
        unregister();

        expect((Plugin.prototype as unknown as { addRibbonIcon?: Plugin["addRibbonIcon"] }).addRibbonIcon).toBe(original);
    });
});
