import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";
import { patchPluginEnableDisable } from "src/patches/plugin-enable-disable";
import { beforeEach, describe, expect, it, vi } from "vitest";

function setup(mode: PLUGIN_MODE) {
    const unloads: (() => void)[] = [];
    const original = {
        enablePlugin: vi.fn().mockResolvedValue(true),
        disablePlugin: vi.fn().mockResolvedValue(undefined),
    };
    const plugins = { ...original };
    const updatePluginSettings = vi.fn().mockResolvedValue(undefined);
    const syncCommandWrappersForPlugin = vi.fn();
    const ctx = {
        obsidianPlugins: plugins,
        getPluginMode: () => mode,
        register: (unload: () => void) => unloads.push(unload),
        _plugin: { updatePluginSettings, features: { get: () => ({ commandCache: { syncCommandWrappersForPlugin } }) } },
    } as unknown as PluginContext;
    patchPluginEnableDisable(ctx);
    return { original, plugins, updatePluginSettings, syncCommandWrappersForPlugin, unpatch: () => unloads.forEach((unload) => unload()) };
}

describe("patchPluginEnableDisable", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("syncs the saved mode only for user toggles", async () => {
        const t = setup(PLUGIN_MODE.ALWAYS_DISABLED);

        await t.plugins.enablePlugin("p");
        expect(t.updatePluginSettings).not.toHaveBeenCalled();

        await t.plugins.enablePlugin("p", true);
        expect(t.updatePluginSettings).toHaveBeenCalledWith("p", PLUGIN_MODE.ALWAYS_ENABLED);
    });

    it("leaves always-enabled plugins alone when restricted mode or an in-memory toggle unloads them", async () => {
        const t = setup(PLUGIN_MODE.ALWAYS_ENABLED);

        await t.plugins.disablePlugin("p");
        expect(t.updatePluginSettings).not.toHaveBeenCalled();

        await t.plugins.disablePlugin("p", true);
        expect(t.updatePluginSettings).toHaveBeenCalledWith("p", PLUGIN_MODE.ALWAYS_DISABLED);
    });

    it("re-syncs command wrappers after every toggle, flagged or not", async () => {
        const t = setup(PLUGIN_MODE.LAZY);

        await t.plugins.disablePlugin("p");
        await t.plugins.enablePlugin("p");
        await t.plugins.disablePlugin("p", true);

        expect(t.syncCommandWrappersForPlugin).toHaveBeenCalledTimes(3);
        expect(t.updatePluginSettings).not.toHaveBeenCalled();
    });

    it("forwards the flag and result to Obsidian and restores it on unload", async () => {
        const t = setup(PLUGIN_MODE.LAZY);

        expect(await t.plugins.enablePlugin("p", true)).toBe(true);
        await t.plugins.disablePlugin("q", true);
        expect(t.original.enablePlugin).toHaveBeenCalledWith("p", true);
        expect(t.original.disablePlugin).toHaveBeenCalledWith("q", true);

        t.unpatch();
        expect(t.plugins.enablePlugin).toBe(t.original.enablePlugin);
    });
});
