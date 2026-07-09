import { Plugin } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import type { DeviceSettings } from "src/core/types";
import { PLUGIN_MODE } from "src/core/types";
import { patchPluginRegisterView } from "src/patches/view-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("patchPluginRegisterView", () => {
    let originalRegisterView: unknown;
    let registerViewSpy: ReturnType<typeof vi.fn>;
    let settings: DeviceSettings;
    let saveSettings: ReturnType<typeof vi.fn>;
    let uninstall: (() => void) | undefined;

    beforeEach(() => {
        originalRegisterView = (Plugin.prototype as unknown as Record<string, unknown>).registerView;
        registerViewSpy = vi.fn();
        (Plugin.prototype as unknown as Record<string, unknown>).registerView = registerViewSpy;

        settings = {
            plugins: {
                "lazy-plugin": {
                    mode: PLUGIN_MODE.LAZY,
                    userConfigured: true,
                    lazyOptions: {
                        useView: true,
                        viewTypes: [],
                        useFile: false,
                        fileCriteria: {},
                    },
                },
                "eager-plugin": {
                    mode: PLUGIN_MODE.ALWAYS_ENABLED,
                    userConfigured: true,
                },
            },
            lazyOnViews: {},
        } as unknown as DeviceSettings;
        saveSettings = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        uninstall?.();
        uninstall = undefined;
        if (originalRegisterView !== undefined) {
            (Plugin.prototype as unknown as Record<string, unknown>).registerView = originalRegisterView;
        } else {
            Reflect.deleteProperty(Plugin.prototype, "registerView");
        }
    });

    function createMockCtx(): PluginContext {
        return {
            getSettings: () => settings,
            getPluginMode: (id: string) => settings.plugins[id]?.mode,
            saveSettings,
        } as unknown as PluginContext;
    }

    interface TestPlugin {
        manifest: { id: string };
        registerView(type: string, viewCreator: unknown): void;
    }

    function createPluginInstance(id: string): TestPlugin {
        const plugin = Object.create(Plugin.prototype) as TestPlugin;
        plugin.manifest = { id };
        return plugin;
    }

    it("attributes view types registered after async onload to the owning plugin", () => {
        uninstall = patchPluginRegisterView(createMockCtx());

        // Simulate a registerView call happening long after onload returned
        // (loadingPluginId is already cleared at this point).
        const plugin = createPluginInstance("lazy-plugin");
        const creator = vi.fn();
        plugin.registerView("lazy-view", creator);

        expect(settings.plugins["lazy-plugin"].lazyOptions?.viewTypes).toContain("lazy-view");
        expect(settings.lazyOnViews?.["lazy-plugin"]).toContain("lazy-view");
        expect(saveSettings).toHaveBeenCalled();
        // Original behavior must be preserved
        expect(registerViewSpy).toHaveBeenCalledWith("lazy-view", creator);
    });

    it("ignores plugins that are not lazy with useView", () => {
        uninstall = patchPluginRegisterView(createMockCtx());

        const plugin = createPluginInstance("eager-plugin");
        plugin.registerView("eager-view", vi.fn());

        expect(settings.lazyOnViews?.["eager-plugin"]).toBeUndefined();
        expect(saveSettings).not.toHaveBeenCalled();
        expect(registerViewSpy).toHaveBeenCalled();
    });

    it("does not save again for an already-tracked view type", () => {
        uninstall = patchPluginRegisterView(createMockCtx());

        const plugin = createPluginInstance("lazy-plugin");
        plugin.registerView("lazy-view", vi.fn());
        plugin.registerView("lazy-view", vi.fn());

        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(settings.lazyOnViews?.["lazy-plugin"]).toEqual(["lazy-view"]);
    });
});
