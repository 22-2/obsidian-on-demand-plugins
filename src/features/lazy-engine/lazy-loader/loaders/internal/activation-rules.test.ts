import type { TFile } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE, type DeviceSettings } from "src/core/types";
import { resolvePluginForFile, resolvePluginForViewType } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import { describe, expect, it, vi } from "vitest";

function createCtx(settings: DeviceSettings, modes: Record<string, PLUGIN_MODE>): PluginContext {
    return {
        getSettings: () => settings,
        getPluginMode: (pluginId: string) => modes[pluginId] ?? PLUGIN_MODE.ALWAYS_DISABLED,
    } as PluginContext;
}

function createFileCtx(settings: DeviceSettings, modes: Record<string, PLUGIN_MODE>) {
    const app = {
        metadataCache: { getFileCache: vi.fn().mockReturnValue(null) },
        vault: { cachedRead: vi.fn().mockResolvedValue("") },
    };
    return { ctx: { ...createCtx(settings, modes), app } as unknown as PluginContext, app };
}

function createSettings(overrides: Partial<DeviceSettings> = {}): DeviceSettings {
    return {
        defaultMode: PLUGIN_MODE.LAZY,
        pruneUninstalledEntries: false,
        plugins: {},
        lazyOnViews: {},
        lazyOnFiles: {},
        ...overrides,
    };
}

function createFile(overrides: Partial<Pick<TFile, "basename" | "name" | "path">> = {}): TFile {
    return {
        basename: "note",
        name: "note.md",
        path: "folder/note.md",
        ...overrides,
    } as TFile;
}

describe("resolvePluginForViewType", () => {
    it("resolves plugin when both useView and useFile are enabled", () => {
        const settings: DeviceSettings = {
            defaultMode: PLUGIN_MODE.LAZY,
            pruneUninstalledEntries: false,
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
            pruneUninstalledEntries: false,
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
            pruneUninstalledEntries: false,
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

describe("resolvePluginForFile", () => {
    it("resolves a modern lazy option using a trimmed suffix against the file name", async () => {
        const settings = createSettings({
            plugins: {
                "plugin-a": {
                    lazyOptions: {
                        useView: false,
                        viewTypes: [],
                        useFile: true,
                        fileCriteria: { suffixes: ["  .mfdi.md  "] },
                    },
                },
            },
        });
        const { ctx } = createFileCtx(settings, { "plugin-a": PLUGIN_MODE.LAZY });

        await expect(resolvePluginForFile(ctx, createFile({ name: "map.mfdi.md" }))).resolves.toBe("plugin-a");
    });

    it("resolves a legacy file rule and built-in default rules", async () => {
        const settings = createSettings({
            lazyOnFiles: {
                "legacy-plugin": { suffixes: [".board"] },
            },
        });
        const { ctx } = createFileCtx(settings, {
            "legacy-plugin": PLUGIN_MODE.LAZY,
            "obsidian-excalidraw-plugin": PLUGIN_MODE.LAZY,
        });

        await expect(resolvePluginForFile(ctx, createFile({ basename: "project.board", name: "project.board.md" }))).resolves.toBe("legacy-plugin");
        await expect(resolvePluginForFile(ctx, createFile({ basename: "sketch.excalidraw", name: "sketch.excalidraw.md" }))).resolves.toBe("obsidian-excalidraw-plugin");
    });

    it("matches frontmatter keys only when the key is present", async () => {
        const settings = createSettings({
            lazyOnFiles: { "frontmatter-plugin": { frontmatterKeys: ["excalidraw-plugin"] } },
        });
        const { ctx, app } = createFileCtx(settings, { "frontmatter-plugin": PLUGIN_MODE.LAZY });
        const file = createFile();

        app.metadataCache.getFileCache.mockReturnValueOnce({ frontmatter: { "excalidraw-plugin": null } });
        await expect(resolvePluginForFile(ctx, file)).resolves.toBe("frontmatter-plugin");

        app.metadataCache.getFileCache.mockReturnValueOnce({ frontmatter: { other: true } });
        await expect(resolvePluginForFile(ctx, file)).resolves.toBeNull();
    });

    it("matches content patterns and returns null when no pattern matches", async () => {
        const settings = createSettings({
            lazyOnFiles: { "content-plugin": { contentPatterns: ["^---\\n.*kind: canvas"] } },
        });
        const { ctx, app } = createFileCtx(settings, { "content-plugin": PLUGIN_MODE.LAZY });
        app.vault.cachedRead.mockResolvedValueOnce("---\nkind: canvas\n---");
        await expect(resolvePluginForFile(ctx, createFile())).resolves.toBe("content-plugin");

        app.vault.cachedRead.mockResolvedValueOnce("plain note");
        await expect(resolvePluginForFile(ctx, createFile())).resolves.toBeNull();
    });

    it("ignores non-lazy plugins and continues after a content read fails", async () => {
        const settings = createSettings({
            plugins: {
                "content-plugin": {
                    lazyOptions: {
                        useView: false,
                        viewTypes: [],
                        useFile: true,
                        fileCriteria: { contentPatterns: ["canvas"] },
                    },
                },
            },
            lazyOnFiles: { "legacy-plugin": { suffixes: [".legacy"] } },
        });
        const { ctx, app } = createFileCtx(settings, {
            "content-plugin": PLUGIN_MODE.LAZY,
            "legacy-plugin": PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
            disabled: PLUGIN_MODE.ALWAYS_DISABLED,
        });
        app.vault.cachedRead.mockRejectedValueOnce(new Error("read failed"));

        await expect(resolvePluginForFile(ctx, createFile({ basename: "doc.legacy", name: "doc.legacy.md" }))).resolves.toBe("legacy-plugin");

        const disabledSettings = createSettings({ lazyOnFiles: { disabled: { suffixes: [".legacy"] } } });
        const { ctx: disabledCtx } = createFileCtx(disabledSettings, { disabled: PLUGIN_MODE.ALWAYS_DISABLED });
        await expect(resolvePluginForFile(disabledCtx, createFile({ basename: "doc.legacy", name: "doc.legacy.md" }))).resolves.toBeNull();
    });
});
