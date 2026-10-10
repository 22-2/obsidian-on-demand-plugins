import { Plugin } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { patchPluginInitialization, waitForPluginInitialization } from "src/patches/plugin-initialization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugin initialization tracking", () => {
    let restore: () => void;
    let originalLoad: PropertyDescriptor | undefined;

    beforeEach(() => {
        originalLoad = Object.getOwnPropertyDescriptor(Plugin.prototype, "load");
        Object.defineProperty(Plugin.prototype, "load", {
            configurable: true,
            writable: true,
            value: function (this: Plugin) {
                    void this.onload();
            },
        });
        restore = patchPluginInitialization();
    });
    afterEach(() => {
        restore();
        if (originalLoad) Object.defineProperty(Plugin.prototype, "load", originalLoad);
        else Reflect.deleteProperty(Plugin.prototype, "load");
        vi.useRealTimers();
    });
    function context(plugin: Plugin): PluginContext {
        return { obsidianPlugins: { plugins: { target: plugin } } } as unknown as PluginContext;
    }
    it("waits for the async onload promise while preserving synchronous load and restoring onload", async () => {
        let finish!: () => void;
        const onload = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, { onload });
        expect(plugin.load()).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(plugin, "onload")?.value).toBe(onload);
        const ready = vi.fn();
        const waiting = waitForPluginInitialization(context(plugin), "target").then(ready);
        await Promise.resolve();
        expect(ready).not.toHaveBeenCalled();
        finish();
        await waiting;
        expect(ready).toHaveBeenCalledOnce();
        expect(onload).toHaveBeenCalledOnce();
    });
    it("propagates async initialization failure instead of treating an empty snapshot as success", async () => {
        const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, {
            onload: () => Promise.reject(new Error("initialization failed")),
        });
        plugin.load();
        await expect(waitForPluginInitialization(context(plugin), "target")).rejects.toThrow("initialization failed");
    });
    it("bounds a plugin whose onload never resolves", async () => {
        vi.useFakeTimers();
        const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, { onload: () => new Promise<void>(() => {}) });
        plugin.load();
        const assertion = expect(waitForPluginInitialization(context(plugin), "target")).rejects.toThrow("Timeout initializing plugin target");
        await vi.advanceTimersByTimeAsync(15_000);
        await assertion;
    });
});
