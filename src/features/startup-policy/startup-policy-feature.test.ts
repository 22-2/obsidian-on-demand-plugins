import type { PluginContext } from "src/core/plugin-context";
import type { ProgressDialog } from "src/core/progress";
import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import { StartupPolicyFeature } from "src/features/startup-policy/startup-policy-feature";
import { waitForPluginInitialization } from "src/patches/plugin-initialization";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/storage");
vi.mock("src/patches/plugin-initialization");

function setup(count = 5, drift?: { confirmOverwrite: () => Promise<boolean> }) {
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
    const features = {
        get: (featureClass: unknown) => (featureClass === LazyEngineFeature ? { commandCache: cache } : featureClass === CommunityPluginsDriftFeature ? drift : undefined),
    };
    const registry = { writeCommunityPluginsFile, loadEnabledPluginsFromDisk: vi.fn().mockResolvedValue(undefined), enabledPluginsFromDisk: new Set<string>() };
    feature.onload(ctx, { registry } as never, features as never, {} as never);
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
    return { feature, plugins, cache, settings, saveSettings, reload, progress, writeCommunityPluginsFile, registry, dialog: progress as unknown as ProgressDialog, cancel: () => cancel() };
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

    it("still restarts when applying settings although a plugin fails to initialize", async () => {
        const t = setup(2);
        vi.mocked(waitForPluginInitialization).mockImplementation(async (_ctx, id) => {
            if (id === "plugin-0") throw new Error("failed onload");
        });
        await t.feature.applyWithProgress(t.dialog);
        expect(t.cache.snapshotCommandsForPlugin).toHaveBeenCalledWith("plugin-1");
        expect(t.cache.persistCache).toHaveBeenCalledOnce();
        expect(t.plugins.plugins).toEqual({});
        expect(t.reload).toHaveBeenCalledWith("app:reload");
    });

    it("re-enables a running plugin when reloading it for view capture fails", async () => {
        const t = setup(1);
        t.settings.plugins["plugin-0"].lazyOptions = { useView: true, viewTypes: [], useFile: false, fileCriteria: {} };
        t.plugins.plugins["plugin-0"] = { _loaded: true };
        t.plugins.enablePlugin.mockRejectedValueOnce(new Error("failed load"));
        await expect(t.feature.rebuildWithProgress(t.dialog, true)).rejects.toThrow("Failed to rebuild plugin caches");
        expect(t.plugins.enablePlugin).toHaveBeenCalledTimes(2);
        expect(t.plugins.plugins["plugin-0"]).toEqual({ _loaded: true });
    });
});

describe("external community-plugins.json edits", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("leaves the file, plugins and app untouched when the user keeps the external edits", async () => {
        const confirmOverwrite = vi.fn().mockResolvedValue(false);
        const t = setup(3, { confirmOverwrite });

        await t.feature.applyWithProgress(t.dialog);
        await t.feature.rebuildWithProgress(t.dialog, true);

        expect(confirmOverwrite).toHaveBeenCalledTimes(2);
        expect(t.plugins.enablePlugin).not.toHaveBeenCalled();
        expect(t.writeCommunityPluginsFile).not.toHaveBeenCalled();
        expect(t.reload).not.toHaveBeenCalled();
        expect(t.progress.close).toHaveBeenCalledTimes(2);
    });

    it("writes the always-enabled plugins and itself after the user agrees", async () => {
        const confirmOverwrite = vi.fn().mockResolvedValue(true);
        const t = setup(3, { confirmOverwrite });
        t.settings.plugins["plugin-1"] = { mode: "alwaysEnabled", userConfigured: true };

        await t.feature.applyWithProgress(t.dialog);

        expect(t.writeCommunityPluginsFile).toHaveBeenCalledWith(["on-demand-plugins", "plugin-1"], false);
        expect(t.reload).toHaveBeenCalledWith("app:reload");
    });

    it("does not ask again when the caller already showed the external edits", async () => {
        const confirmOverwrite = vi.fn().mockResolvedValue(false);
        const t = setup(3, { confirmOverwrite });

        await t.feature.applyWithProgress(t.dialog, undefined, { externalChangesConfirmed: true });

        expect(confirmOverwrite).not.toHaveBeenCalled();
        expect(t.writeCommunityPluginsFile).toHaveBeenCalled();
    });

    it("still applies when the file cannot be checked", async () => {
        const t = setup(3, { confirmOverwrite: vi.fn().mockRejectedValue(new Error("read failed")) });

        await t.feature.applyWithProgress(t.dialog);

        expect(t.writeCommunityPluginsFile).toHaveBeenCalled();
    });

    it("keeps entries for plugins this device does not manage, such as desktop-only ones on mobile", async () => {
        const t = setup(3, { confirmOverwrite: vi.fn().mockResolvedValue(true) });
        t.settings.plugins["plugin-1"] = { mode: "alwaysEnabled", userConfigured: true };
        // plugin-0 is managed here and lazy; the other two are not installed (or hidden) on this device.
        t.registry.enabledPluginsFromDisk = new Set(["plugin-0", "desktop-only", "other-device-only", "on-demand-plugins"]);

        await t.feature.applyWithProgress(t.dialog);

        expect(t.registry.loadEnabledPluginsFromDisk).toHaveBeenCalled();
        expect(t.writeCommunityPluginsFile).toHaveBeenCalledWith(["desktop-only", "on-demand-plugins", "other-device-only", "plugin-1"], false);
    });
});
