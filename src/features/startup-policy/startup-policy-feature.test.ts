import type { PluginContext } from "src/core/plugin-context";
import type { ProgressDialog } from "src/core/progress";
import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";
import { StartupPolicyFeature } from "src/features/startup-policy/startup-policy-feature";
import { waitForPluginInitialization } from "src/patches/plugin-initialization";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/storage");
vi.mock("src/patches/plugin-initialization");

function setup(count = 5) {
    const settings = structuredClone(DEFAULT_DEVICE_SETTINGS);
    const manifests = Array.from({ length: count }, (_, i) => ({ id: `plugin-${i}`, name: `Plugin ${i}`, version: "1.0.0" }));
    for (const { id } of manifests) settings.plugins[id] = { mode: "lazy", userConfigured: true };
    const instances: Record<string, { _loaded: boolean }> = {};
    const plugins = {
        plugins: instances,
        enabledPlugins: new Set(manifests.map((p) => p.id)),
        enablePlugin: vi.fn(async (id: string) => {
            instances[id] = { _loaded: true };
        }),
        disablePlugin: vi.fn(async (id: string) => {
            delete instances[id];
        }),
    };
    const reload = vi.fn();
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const cache = {
        isCommandCacheValid: vi.fn().mockReturnValue(false),
        snapshotCommandsForPlugin: vi.fn().mockResolvedValue(undefined),
        persistCache: vi.fn(),
        registerCachedCommands: vi.fn(),
    };
    const ctx = {
        app: { plugins, commands: { executeCommandById: reload } },
        obsidianPlugins: plugins,
        getManifests: () => manifests,
        getPluginMode: (id: string) => settings.plugins[id]?.mode,
        getSettings: () => settings,
        getData: () => ({ showConsoleLog: false }),
        saveSettings,
    } as unknown as PluginContext;
    const feature = new StartupPolicyFeature();
    const writeCommunityPluginsFile = vi.fn().mockResolvedValue(undefined);
    feature.onload(ctx, { registry: { writeCommunityPluginsFile } } as never, { get: () => ({ commandCache: cache }) } as never, {} as never);
    let cancel = () => {};
    const progress = {
        setOnCancel: (handler: () => void) => {
            cancel = handler;
        },
        setTotal: vi.fn(),
        setStatus: vi.fn(),
        setProgress: vi.fn<(current: number) => void>(),
        close: vi.fn(),
    };
    return { feature, plugins, cache, settings, saveSettings, reload, progress, dialog: progress as unknown as ProgressDialog, cancel: () => cancel() };
}

describe("combined cache rebuild", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("loads at most three plugins concurrently and restores each temporary load after one snapshot", async () => {
        const t = setup();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let active = 0;
        let maximum = 0;
        t.plugins.enablePlugin.mockImplementation(async (id) => {
            t.plugins.plugins[id] = { _loaded: true };
            maximum = Math.max(maximum, ++active);
            await gate;
            active--;
        });
        const rebuilding = t.feature.rebuildWithProgress(t.dialog, true);
        await vi.waitFor(() => expect(t.plugins.enablePlugin).toHaveBeenCalledTimes(3));
        release();
        await rebuilding;
        expect(maximum).toBe(3);
        expect(t.plugins.enablePlugin.mock.calls.map(([id]) => id).sort()).toEqual(Object.keys(t.settings.plugins));
        expect(t.cache.snapshotCommandsForPlugin).toHaveBeenCalledTimes(5);
        expect(t.cache.persistCache).toHaveBeenCalledOnce();
        expect(t.plugins.disablePlugin).toHaveBeenCalledTimes(5);
        expect(t.plugins.plugins).toEqual({});
        expect(t.progress.setProgress.mock.calls.map(([n]) => n)).toEqual([1, 2, 3, 4, 5]);
        expect(t.saveSettings).toHaveBeenCalledOnce();
        expect(t.reload).toHaveBeenCalledWith("app:reload");
    });

    it("keeps an already loaded plugin running even when it is absent from enabled settings", async () => {
        const t = setup(1);
        t.plugins.enabledPlugins.clear();
        t.plugins.plugins["plugin-0"] = { _loaded: true };
        await t.feature.rebuildWithProgress(t.dialog, true);
        expect(t.plugins.enablePlugin).not.toHaveBeenCalled();
        expect(t.plugins.disablePlugin).not.toHaveBeenCalled();
        expect(t.cache.snapshotCommandsForPlugin).toHaveBeenCalledWith("plugin-0");
    });

    it("stops queued work on cancel and unloads the in-flight plugins without restarting", async () => {
        const t = setup();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(waitForPluginInitialization).mockReturnValue(gate);
        const rebuilding = t.feature.rebuildWithProgress(t.dialog, true);
        await vi.waitFor(() => expect(t.plugins.enablePlugin).toHaveBeenCalledTimes(3));
        t.cancel();
        release();
        await rebuilding;
        expect(t.plugins.enablePlugin).toHaveBeenCalledTimes(3);
        expect(t.plugins.disablePlugin).toHaveBeenCalledTimes(3);
        expect(t.reload).not.toHaveBeenCalled();
        expect(t.progress.close).toHaveBeenCalledOnce();
    });

    it("preserves the previous view cache, unloads and closes progress when async initialization fails", async () => {
        const t = setup(1);
        t.settings.plugins["plugin-0"].lazyOptions = { useView: true, viewTypes: ["previous"], useFile: false, fileCriteria: {} };
        t.settings.lazyOnViews["plugin-0"] = ["previous"];
        vi.mocked(waitForPluginInitialization).mockRejectedValue(new Error("failed onload"));
        await expect(t.feature.rebuildWithProgress(t.dialog, true)).rejects.toThrow("Failed to rebuild plugin caches");
        expect(t.settings.lazyOnViews["plugin-0"]).toEqual(["previous"]);
        expect(t.settings.plugins["plugin-0"].lazyOptions?.viewTypes).toEqual(["previous"]);
        expect(t.cache.snapshotCommandsForPlugin).not.toHaveBeenCalled();
        expect(t.plugins.disablePlugin).toHaveBeenCalledWith("plugin-0");
        expect(t.reload).not.toHaveBeenCalled();
        expect(t.progress.close).toHaveBeenCalledOnce();
    });
});
