import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE, type DeviceSettings } from "src/core/types";
import { resolvePluginForViewType } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import { describe, expect, it } from "vitest";

function createCtx(settings: DeviceSettings, modes: Record<string, PLUGIN_MODE>): PluginContext {
    return {
        getSettings: () => settings,
        getPluginMode: (pluginId: string) => modes[pluginId] ?? PLUGIN_MODE.ALWAYS_DISABLED,
    } as PluginContext;
}

describe("resolvePluginForViewType", () => {
    it("resolves plugin when both useView and useFile are enabled", () => {
        const settings: DeviceSettings = {
            defaultMode: PLUGIN_MODE.LAZY,
            showDescriptions: true,
            plugins: {
                "plugin-a": {
                    mode: PLUGIN_MODE.LAZY,
                    lazyOptions: {
                        useView: true,
                        viewTypes: ["markdown"],
                        useFile: true,
                        fileCriteria: {
                            suffixes: [".canvas"],
                        },
                    },
                },
            },
            lazyOnViews: {},
            lazyOnFiles: {},
        };

        const ctx = createCtx(settings, { "plugin-a": PLUGIN_MODE.LAZY });

        expect(resolvePluginForViewType(ctx, "markdown")).toBe("plugin-a");
    });

    it("resolves legacy lazyOnViews entry even when lazyOnFiles also exists", () => {
        const settings: DeviceSettings = {
            defaultMode: PLUGIN_MODE.LAZY,
            showDescriptions: true,
            plugins: {},
            lazyOnViews: {
                "plugin-b": ["kanban"],
            },
            lazyOnFiles: {
                "plugin-b": {
                    suffixes: [".kanban"],
                },
            },
        };

        const ctx = createCtx(settings, { "plugin-b": PLUGIN_MODE.LAZY });

        expect(resolvePluginForViewType(ctx, "kanban")).toBe("plugin-b");
    });

    it("returns null for non-lazy mode even if view rule matches", () => {
        const settings: DeviceSettings = {
            defaultMode: PLUGIN_MODE.ALWAYS_DISABLED,
            showDescriptions: true,
            plugins: {
                "plugin-c": {
                    mode: PLUGIN_MODE.ALWAYS_ENABLED,
                    lazyOptions: {
                        useView: true,
                        viewTypes: ["excalidraw"],
                        useFile: true,
                        fileCriteria: {
                            suffixes: [".excalidraw"],
                        },
                    },
                },
            },
            lazyOnViews: {},
            lazyOnFiles: {},
        };

        const ctx = createCtx(settings, { "plugin-c": PLUGIN_MODE.ALWAYS_ENABLED });

        expect(resolvePluginForViewType(ctx, "excalidraw")).toBeNull();
    });
});
