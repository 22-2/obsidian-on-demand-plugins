import log from "loglevel";
import type { EventBus } from "src/core/event-bus";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext, SettingsChange } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";
import { LazyEngineFeature } from "src/features/lazy-engine/lazy-engine-feature";
import type { EnableDisableHooks } from "src/patches/plugin-enable-disable";
import type { CoreContainer } from "src/services/core-container";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The feature wires together services that each have their own tests. Replace them
// with stubs so these tests cover only the feature's orchestration logic.
const mocks = vi.hoisted(() => ({}) as { cache: CacheMock; runner: RunnerMock; enableDisableHooks?: EnableDisableHooks });

vi.mock("src/features/lazy-engine/command-cache/command-cache-service", () => ({
    CommandCacheService: class {
        constructor() {
            return mocks.cache;
        }
    },
}));
vi.mock("src/features/lazy-engine/lazy-runner/lazy-command-runner", () => ({
    LazyCommandRunner: class {
        constructor() {
            return mocks.runner;
        }
    },
}));
vi.mock("src/features/lazy-engine/lazy-loader/loaders/view-lazy-loader", () => ({
    ViewLazyLoader: class {
        registerActiveLeafReload() {}
    },
}));
vi.mock("src/features/lazy-engine/lazy-loader/loaders/file-lazy-loader", () => ({
    FileLazyLoader: class {
        register() {}
    },
}));
vi.mock("src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock", () => ({
    LeafLockManager: class {},
    LeafViewLockStrategy: class {},
}));
vi.mock("src/patches/plugin-enable-disable", () => ({
    patchPluginEnableDisable: (_ctx: unknown, hooks: EnableDisableHooks) => {
        mocks.enableDisableHooks = hooks;
    },
}));
vi.mock("src/patches/plugin-load", () => ({ patchPluginLoad: () => () => {} }));
vi.mock("src/patches/plugin-initialization", () => ({ patchPluginInitialization: () => () => {} }));
vi.mock("src/patches/ribbon-reorder", () => ({ patchRibbonReorder: () => {} }));
vi.mock("src/patches/view-registry", () => ({ patchPluginRegisterView: () => () => {} }));
vi.mock("src/patches/view-state", () => ({ patchSetViewState: () => {} }));

type Mode = (typeof PLUGIN_MODE)[keyof typeof PLUGIN_MODE];
type CacheMock = ReturnType<typeof createCacheMock>;
type RunnerMock = ReturnType<typeof createRunnerMock>;

function createCacheMock(calls: string[]) {
    return {
        loadFromData: vi.fn(() => {
            calls.push("loadFromData");
        }),
        registerCachedCommands: vi.fn(() => {
            calls.push("registerCachedCommands");
        }),
        registerCachedCommandsForPlugin: vi.fn((id: string) => {
            calls.push(`registerCachedCommandsForPlugin:${id}`);
        }),
        removeCachedCommandsForPlugin: vi.fn((id: string) => {
            calls.push(`removeCachedCommandsForPlugin:${id}`);
        }),
        ensureCommandsCached: vi.fn(async (id: string): Promise<void> => {
            calls.push(`ensureCommandsCached:${id}`);
        }),
        syncCommandWrappersForPlugin: vi.fn(),
        getStaleCachedPluginIds: vi.fn((): string[] => []),
        refreshStaleCacheForPlugin: vi.fn(async (id: string): Promise<void> => {
            calls.push(`refreshStale:${id}`);
        }),
        clear: vi.fn(),
    };
}

function createRunnerMock(calls: string[], instances: Record<string, { _loaded: boolean }>) {
    return {
        ensurePluginLoaded: vi.fn(async (id: string): Promise<boolean> => {
            calls.push(`ensurePluginLoaded:${id}`);
            instances[id] = { _loaded: true };
            return true;
        }),
        waitForPluginLoaded: vi.fn(async (id: string): Promise<void> => {
            calls.push(`waitForPluginLoaded:${id}`);
        }),
        clear: vi.fn(),
    };
}

function setup(options: { modes?: Record<string, Mode>; loaded?: string[]; layoutReady?: boolean; runLayoutReadyCallback?: boolean } = {}) {
    const modes = options.modes ?? {};
    const saved = { profiles: { p: { settings: { plugins: {} as Record<string, { mode: Mode; userConfigured?: boolean; lazyOnViews?: string[] }> } } } };
    const calls: string[] = [];
    const instances: Record<string, { _loaded: boolean }> = {};
    for (const id of options.loaded ?? []) instances[id] = { _loaded: true };

    const plugins = {
        plugins: instances,
        enabledPlugins: new Set<string>(),
        enablePlugin: vi.fn(async (id: string) => {
            calls.push(`enable:${id}`);
            instances[id] = { _loaded: true };
        }),
        disablePlugin: vi.fn(async (id: string) => {
            calls.push(`disable:${id}`);
            delete instances[id];
        }),
    };

    mocks.cache = createCacheMock(calls);
    mocks.runner = createRunnerMock(calls, instances);

    let layoutReadyCallback: (() => void) | undefined;
    const workspace = {
        layoutReady: options.layoutReady ?? true,
        onLayoutReady: vi.fn((cb: () => void) => {
            calls.push("onLayoutReady:hooked");
            layoutReadyCallback = cb;
            if (options.runLayoutReadyCallback) cb();
        }),
        trigger: vi.fn(),
    };
    const ctx = {
        app: { plugins, workspace },
        obsidianPlugins: plugins,
        register: vi.fn(),
        getManifests: () => Object.keys(modes).map((id) => ({ id, name: id, version: "1.0.0" })),
        getPluginMode: (id: string) => modes[id] ?? PLUGIN_MODE.ALWAYS_DISABLED,
        saveSettingsChange: vi.fn(async (change: SettingsChange) => {
            calls.push("saveSettingsChange");
            await change(saved as never, "p");
            for (const [id, entry] of Object.entries(saved.profiles.p.settings.plugins)) modes[id] = entry.mode;
        }),
    } as unknown as PluginContext;

    const feature = new LazyEngineFeature();
    feature.onload(ctx, {} as CoreContainer, {} as FeatureManager, {} as EventBus);

    return {
        feature,
        plugins,
        workspace,
        cache: mocks.cache,
        runner: mocks.runner,
        calls,
        saved,
        isLoaded: (id: string) => Boolean(instances[id]?._loaded),
        fireLayoutReady: () => layoutReadyCallback?.(),
    };
}

describe("LazyEngineFeature.applyPluginState", () => {
    describe("ALWAYS_ENABLED", () => {
        it("enables an unloaded plugin, waits for it to load, and drops its cached command wrappers", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.ALWAYS_ENABLED } });
            t.calls.length = 0;

            await t.feature.applyPluginState("a");

            expect(t.calls).toEqual(["enable:a", "waitForPluginLoaded:a", "removeCachedCommandsForPlugin:a"]);
        });

        it("does not re-enable a plugin that is already loaded", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.ALWAYS_ENABLED }, loaded: ["a"] });

            await t.feature.applyPluginState("a");

            expect(t.plugins.enablePlugin).not.toHaveBeenCalled();
            expect(t.runner.waitForPluginLoaded).not.toHaveBeenCalled();
            expect(t.cache.removeCachedCommandsForPlugin).toHaveBeenCalledWith("a");
        });
    });

    describe("LAZY", () => {
        it("caches commands, unloads the plugin that caching loaded, then registers wrappers", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.LAZY } });
            t.cache.ensureCommandsCached.mockImplementation(async (id: string) => {
                t.calls.push(`ensureCommandsCached:${id}`);
                // Snapshotting commands loads the plugin as a side effect.
                await t.plugins.enablePlugin(id);
            });
            t.calls.length = 0;

            await t.feature.applyPluginState("a");

            expect(t.calls).toEqual(["ensureCommandsCached:a", "enable:a", "disable:a", "registerCachedCommandsForPlugin:a"]);
            expect(t.isLoaded("a")).toBe(false);
        });

        it("skips disabling when the plugin is not loaded after caching", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.LAZY } });

            await t.feature.applyPluginState("a");

            expect(t.plugins.disablePlugin).not.toHaveBeenCalled();
            expect(t.cache.registerCachedCommandsForPlugin).toHaveBeenCalledWith("a");
        });

        it("still unloads the plugin and registers wrappers when caching fails", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.LAZY } });
            t.cache.ensureCommandsCached.mockImplementation(async (id: string) => {
                // Plugin onload threw after enablePlugin had already loaded it.
                await t.plugins.enablePlugin(id);
                throw new Error("onload failed");
            });

            await expect(t.feature.applyPluginState("a")).rejects.toThrow("onload failed");

            expect(t.plugins.disablePlugin).toHaveBeenCalledWith("a");
            expect(t.isLoaded("a")).toBe(false);
            expect(t.cache.registerCachedCommandsForPlugin).toHaveBeenCalledWith("a");
        });
    });

    describe("LAZY_ON_LAYOUT_READY", () => {
        it("drops cached wrappers and loads the plugin right away when the layout is already ready", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.LAZY_ON_LAYOUT_READY }, layoutReady: true });
            t.calls.length = 0;

            await t.feature.applyPluginState("a");

            expect(t.calls).toEqual(["removeCachedCommandsForPlugin:a", "ensurePluginLoaded:a"]);
        });

        it("leaves loading to the layout-ready hook when the layout is not ready yet", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.LAZY_ON_LAYOUT_READY }, layoutReady: false });

            await t.feature.applyPluginState("a");

            expect(t.cache.removeCachedCommandsForPlugin).toHaveBeenCalledWith("a");
            expect(t.runner.ensurePluginLoaded).not.toHaveBeenCalled();
        });
    });

    describe("ALWAYS_DISABLED", () => {
        it("disables a loaded plugin and drops its cached wrappers", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.ALWAYS_DISABLED }, loaded: ["a"] });
            t.calls.length = 0;

            await t.feature.applyPluginState("a");

            expect(t.calls).toEqual(["disable:a", "removeCachedCommandsForPlugin:a"]);
        });

        it("only drops cached wrappers when the plugin is not loaded", async () => {
            const t = setup({ modes: { a: PLUGIN_MODE.ALWAYS_DISABLED } });

            await t.feature.applyPluginState("a");

            expect(t.plugins.disablePlugin).not.toHaveBeenCalled();
            expect(t.plugins.enablePlugin).not.toHaveBeenCalled();
            expect(t.cache.removeCachedCommandsForPlugin).toHaveBeenCalledWith("a");
        });
    });
});

describe("LazyEngineFeature layout-ready flow", () => {
    let consoleError: MockInstance<(...msg: unknown[]) => void>;

    beforeEach(() => {
        // Reason: loglevel binds console methods when the logger is created, so spying on console misses its output.
        consoleError = vi.spyOn(log.getLogger("OnDemandPlugin/LazyEngineFeature"), "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    it("loads the command cache before hooking onLayoutReady so a synchronous callback sees it", async () => {
        const t = setup({ modes: { a: PLUGIN_MODE.LAZY_ON_LAYOUT_READY }, runLayoutReadyCallback: true });
        t.cache.getStaleCachedPluginIds.mockReturnValue([]);

        expect(t.calls.slice(0, 3)).toEqual(["loadFromData", "registerCachedCommands", "onLayoutReady:hooked"]);
        await vi.waitFor(() => expect(t.cache.getStaleCachedPluginIds).toHaveBeenCalled());
    });

    it("loads only lazyOnLayoutReady plugins, re-registers cached commands, then refreshes stale caches", async () => {
        const t = setup({
            modes: {
                ready1: PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
                lazy: PLUGIN_MODE.LAZY,
                ready2: PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
                always: PLUGIN_MODE.ALWAYS_ENABLED,
                off: PLUGIN_MODE.ALWAYS_DISABLED,
            },
        });
        t.cache.getStaleCachedPluginIds.mockReturnValue(["stale"]);
        t.calls.length = 0;

        t.fireLayoutReady();
        await vi.waitFor(() => expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalled());

        expect(t.runner.ensurePluginLoaded.mock.calls.map(([id]) => id).sort()).toEqual(["ready1", "ready2"]);
        // Stale caches are rebuilt only after layout-ready plugins finished loading,
        // so refreshStaleCacheForPlugin sees the final enabled state.
        expect(t.calls.slice(2)).toEqual(["registerCachedCommands", "refreshStale:stale"]);
    });

    it("skips the extra registration when no plugin loads on layout ready but still refreshes stale caches", async () => {
        const t = setup({ modes: { lazy: PLUGIN_MODE.LAZY } });
        t.cache.getStaleCachedPluginIds.mockReturnValue(["lazy"]);
        t.cache.registerCachedCommands.mockClear();

        t.fireLayoutReady();
        await vi.waitFor(() => expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalledWith("lazy"));

        expect(t.runner.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(t.cache.registerCachedCommands).not.toHaveBeenCalled();
    });

    it("does nothing after layout ready when there is nothing to load or refresh", async () => {
        const t = setup({ modes: { lazy: PLUGIN_MODE.LAZY } });
        t.cache.registerCachedCommands.mockClear();

        t.fireLayoutReady();
        await vi.waitFor(() => expect(t.cache.getStaleCachedPluginIds).toHaveBeenCalled());

        expect(t.runner.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(t.cache.registerCachedCommands).not.toHaveBeenCalled();
        expect(t.cache.refreshStaleCacheForPlugin).not.toHaveBeenCalled();
    });

    it("keeps going when one layout-ready plugin fails to load", async () => {
        const t = setup({ modes: { bad: PLUGIN_MODE.LAZY_ON_LAYOUT_READY, good: PLUGIN_MODE.LAZY_ON_LAYOUT_READY } });
        t.runner.ensurePluginLoaded.mockImplementation(async (id: string) => {
            if (id === "bad") throw new Error("boom");
            return true;
        });
        t.cache.getStaleCachedPluginIds.mockReturnValue(["stale"]);
        t.cache.registerCachedCommands.mockClear();

        t.fireLayoutReady();
        await vi.waitFor(() => expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalledWith("stale"));

        expect(t.runner.ensurePluginLoaded).toHaveBeenCalledWith("good");
        expect(t.cache.registerCachedCommands).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith("Failed loading plugin onLayoutReady", "bad", expect.any(Error));
    });

    it("refreshes every stale cache even when one refresh fails", async () => {
        const t = setup({ modes: {} });
        t.cache.getStaleCachedPluginIds.mockReturnValue(["bad", "good"]);
        t.cache.refreshStaleCacheForPlugin.mockImplementation(async (id: string) => {
            if (id === "bad") throw new Error("boom");
        });

        t.fireLayoutReady();
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith("Failed refreshing stale command cache", "bad", expect.any(Error)));

        expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalledWith("good");
    });

    it("loads at most three layout-ready plugins concurrently", async () => {
        const ids = ["p0", "p1", "p2", "p3", "p4"];
        const t = setup({ modes: Object.fromEntries(ids.map((id) => [id, PLUGIN_MODE.LAZY_ON_LAYOUT_READY])) });
        let active = 0;
        let maximum = 0;
        t.runner.ensurePluginLoaded.mockImplementation(async () => {
            maximum = Math.max(maximum, ++active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return true;
        });

        t.fireLayoutReady();
        await vi.waitFor(() => expect(t.cache.getStaleCachedPluginIds).toHaveBeenCalled());

        expect(t.runner.ensurePluginLoaded).toHaveBeenCalledTimes(ids.length);
        expect(maximum).toBe(3);
    });

    it("settles without refreshing caches when unloaded with queued plugins", async () => {
        const ids = ["p0", "p1", "p2", "p3", "p4"];
        const t = setup({ modes: Object.fromEntries(ids.map((id) => [id, PLUGIN_MODE.LAZY_ON_LAYOUT_READY])) });
        let release!: () => void;
        const running = new Promise<void>((resolve) => { release = resolve; });
        t.runner.ensurePluginLoaded.mockImplementation(async () => { await running; return true; });
        t.cache.registerCachedCommands.mockClear();
        const work = (t.feature as unknown as { onLayoutReady(): Promise<void> }).onLayoutReady();
        const result = work.then(() => "completed", (error: unknown) => error instanceof Error ? error.name : String(error));
        expect(t.runner.ensurePluginLoaded).toHaveBeenCalledTimes(3);
        t.feature.onunload();
        release();

        expect(await result).toBe("completed");
        expect(t.runner.ensurePluginLoaded).toHaveBeenCalledTimes(3);
        expect(t.cache.registerCachedCommands).not.toHaveBeenCalled();
        expect(t.cache.getStaleCachedPluginIds).not.toHaveBeenCalled();
    });

    it("settles when unloaded with stale cache refreshes still queued", async () => {
        const t = setup();
        t.cache.getStaleCachedPluginIds.mockReturnValue(["p0", "p1", "p2", "p3"]);
        let release!: () => void;
        const running = new Promise<void>((resolve) => { release = resolve; });
        t.cache.refreshStaleCacheForPlugin.mockImplementation(async () => { await running; });
        const work = (t.feature as unknown as { onLayoutReady(): Promise<void> }).onLayoutReady();
        const result = work.then(() => "completed", (error: unknown) => error instanceof Error ? error.name : String(error));
        expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalledTimes(3);
        t.feature.onunload();
        release();
        expect(await result).toBe("completed");
        expect(t.cache.refreshStaleCacheForPlugin).toHaveBeenCalledTimes(3);
    });

    it("does not refresh after a running load finishes following unload", async () => {
        const t = setup({ modes: { p0: PLUGIN_MODE.LAZY_ON_LAYOUT_READY } });
        let release!: () => void;
        const running = new Promise<void>((resolve) => { release = resolve; });
        t.runner.ensurePluginLoaded.mockImplementation(async () => { await running; return true; });
        t.cache.registerCachedCommands.mockClear();
        const work = (t.feature as unknown as { onLayoutReady(): Promise<void> }).onLayoutReady();
        t.feature.onunload();
        release();
        await work;
        expect(t.cache.registerCachedCommands).not.toHaveBeenCalled();
        expect(t.cache.getStaleCachedPluginIds).not.toHaveBeenCalled();
    });

    it("ignores a layout-ready callback delivered after unload", async () => {
        const t = setup({ modes: { p0: PLUGIN_MODE.LAZY_ON_LAYOUT_READY } });
        t.feature.onunload();
        t.fireLayoutReady();
        await Promise.resolve();
        expect(t.runner.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(t.cache.getStaleCachedPluginIds).not.toHaveBeenCalled();
    });
});

describe("LazyEngineFeature.setPluginMode", () => {
    it("saves the mode without dropping the plugin's lazy rules, then applies it", async () => {
        const t = setup({ modes: { a: PLUGIN_MODE.ALWAYS_DISABLED } });
        t.saved.profiles.p.settings.plugins.a = { mode: PLUGIN_MODE.ALWAYS_DISABLED, lazyOnViews: ["markdown"] };
        t.calls.length = 0;

        await t.feature.setPluginMode("a", PLUGIN_MODE.ALWAYS_ENABLED);

        expect(t.saved.profiles.p.settings.plugins.a).toEqual({ mode: PLUGIN_MODE.ALWAYS_ENABLED, userConfigured: true, lazyOnViews: ["markdown"] });
        expect(t.calls).toEqual(["saveSettingsChange", "enable:a", "waitForPluginLoaded:a", "removeCachedCommandsForPlugin:a"]);
    });

    it("is what the enable/disable patch calls, alongside the command cache wrapper sync", async () => {
        const t = setup({ modes: { a: PLUGIN_MODE.LAZY } });
        const hooks = mocks.enableDisableHooks!;

        hooks.syncCommandWrappers("a");
        await hooks.setPluginMode("a", PLUGIN_MODE.ALWAYS_DISABLED);

        expect(t.cache.syncCommandWrappersForPlugin).toHaveBeenCalledWith("a");
        expect(t.saved.profiles.p.settings.plugins.a).toEqual({ mode: PLUGIN_MODE.ALWAYS_DISABLED, userConfigured: true });
    });
});

describe("LazyEngineFeature.onunload", () => {
    it("clears the command cache and the runner", () => {
        const t = setup();

        t.feature.onunload();

        expect(t.cache.clear).toHaveBeenCalled();
        expect(t.runner.clear).toHaveBeenCalled();
    });
});
