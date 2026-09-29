import type { Plugins } from "@obsidian-typings/obsidian-public-latest";
import { patchPluginLoad } from "src/patches/plugin-load";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("patchPluginLoad", () => {
    let uninstall: (() => void) | undefined;
    afterEach(() => uninstall?.());

    it("prevents CLI and lazy loads from creating duplicate view registrations", async () => {
        let finishRead!: () => void;
        const reading = new Promise<void>((resolve) => {
            finishRead = resolve;
        });
        const instances = new Map<string, object>();
        const views = new Set<string>();
        const loadPlugin = vi.fn(async (id: string) => {
            if (instances.has(id)) return instances.get(id);
            // Model Obsidian's async script read before it records the new instance.
            await reading;
            const instance = {};
            instances.set(id, instance);
            if (views.has(id)) throw new Error("Attempting to register an existing view type");
            views.add(id);
            return instance;
        });
        const plugins = { loadPlugin } as unknown as Plugins;
        uninstall = patchPluginLoad(plugins);

        const cliLoad = plugins.loadPlugin("graph-analysis-ex");
        const lazyLoad = plugins.loadPlugin("graph-analysis-ex");
        finishRead();
        const [cliInstance, lazyInstance] = await Promise.all([cliLoad, lazyLoad]);

        expect(cliInstance).toBe(lazyInstance);
        expect(loadPlugin).toHaveBeenCalledTimes(1);
        expect(views.size).toBe(1);

        // A completed flight must not prevent a subsequent intentional reload.
        instances.clear();
        views.clear();
        expect(await plugins.loadPlugin("graph-analysis-ex")).not.toBe(cliInstance);
        expect(loadPlugin).toHaveBeenCalledTimes(2);
    });

    it("allows retries after failure and preserves the receiver and arguments", async () => {
        const loadPlugin = vi.fn().mockRejectedValueOnce(new Error("read failed")).mockResolvedValue({});
        const plugins = { loadPlugin } as unknown as Plugins;
        uninstall = patchPluginLoad(plugins);

        await expect(plugins.loadPlugin("graph-analysis-ex", true)).rejects.toThrow("read failed");
        await plugins.loadPlugin("graph-analysis-ex", true);

        expect(loadPlugin).toHaveBeenCalledTimes(2);
        expect(loadPlugin).toHaveBeenLastCalledWith("graph-analysis-ex", true);
        expect(loadPlugin.mock.contexts).toEqual([plugins, plugins]);
    });

    it("loads different plugins independently and restores the loader on uninstall", async () => {
        let finishFirst!: () => void;
        const first = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const loadPlugin = vi.fn(async (id: string) => {
            if (id === "first") await first;
            return id;
        });
        const plugins = { loadPlugin } as unknown as Plugins;
        uninstall = patchPluginLoad(plugins);

        const loadingFirst = plugins.loadPlugin("first");
        expect(await plugins.loadPlugin("second")).toBe("second");
        finishFirst();
        await loadingFirst;
        uninstall();
        expect(Object.getOwnPropertyDescriptor(plugins, "loadPlugin")?.value).toBe(loadPlugin);
    });
});
