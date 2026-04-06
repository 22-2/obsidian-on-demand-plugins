import { PLUGIN_MODE } from "src/core/types";
import { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("MaintenanceFeature", () => {
    let feature: MaintenanceFeature;
    let settingsState: {
        plugins: Record<string, { mode: string }>;
    };
    let mockCtx: {
        getData: () => { showConsoleLog: boolean };
        getManifests: ReturnType<typeof vi.fn>;
        getSettings: () => typeof settingsState;
        getPluginMode: (id: string) => string | undefined;
        saveSettings: ReturnType<typeof vi.fn>;
        _plugin: { manifest: { id: string } };
    };
    let mockRegistry: {
        loadEnabledPluginsFromDisk: ReturnType<typeof vi.fn>;
        writeCommunityPluginsFile: ReturnType<typeof vi.fn>;
        enabledPluginsFromDisk: Set<string>;
    };

    beforeEach(() => {
        settingsState = {
            plugins: {
                "plugin-1": { mode: PLUGIN_MODE.ALWAYS_DISABLED },
                "plugin-2": { mode: PLUGIN_MODE.ALWAYS_ENABLED },
            },
        };

        mockCtx = {
            getData: () => ({ showConsoleLog: false }),
            getManifests: vi.fn().mockReturnValue([
                { id: "plugin-1", name: "Plugin 1" },
                { id: "plugin-2", name: "Plugin 2" },
            ]),
            getSettings: () => settingsState,
            getPluginMode: (id) => mockCtx.getSettings().plugins[id]?.mode,
            saveSettings: vi.fn().mockResolvedValue(undefined),
            _plugin: { manifest: { id: "on-demand-plugins" } },
        };

        mockRegistry = {
            loadEnabledPluginsFromDisk: vi.fn().mockResolvedValue(undefined),
            writeCommunityPluginsFile: vi.fn().mockResolvedValue(undefined),
            enabledPluginsFromDisk: new Set(["plugin-1", "on-demand-plugins"]),
        };

        feature = new MaintenanceFeature();
        const mockEvents = { emit: vi.fn(), on: vi.fn() };
        feature.onload(mockCtx as never, { registry: mockRegistry } as never, {} as never, mockEvents as never);
    });

    describe("applyBatchModeReplace", () => {
        it("should replace modes for matching plugins", () => {
            const changed = feature.applyBatchModeReplace(PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.LAZY);

            expect(changed).toBe(1);
            expect(mockCtx.getSettings().plugins["plugin-1"].mode).toBe(PLUGIN_MODE.LAZY);
            expect(mockCtx.getSettings().plugins["plugin-2"].mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
        });

        it("should return 0 if no plugins match", () => {
            const changed = feature.applyBatchModeReplace(PLUGIN_MODE.LAZY, PLUGIN_MODE.ALWAYS_ENABLED);
            expect(changed).toBe(0);
        });
    });

    describe("executeSync coreToLazy", () => {
        it("should sync from disk to lazy settings", async () => {
            // plugin-1 is on disk but ALWAYS_DISABLED -> should become ALWAYS_ENABLED
            // plugin-2 is NOT on disk but ALWAYS_ENABLED -> should become ALWAYS_DISABLED
            mockRegistry.enabledPluginsFromDisk = new Set(["plugin-1", "on-demand-plugins"]);

            const result = await feature.executeSync("coreToLazy");

            expect(result.changed).toBe(2);
            expect(mockCtx.getSettings().plugins["plugin-1"].mode).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
            expect(mockCtx.getSettings().plugins["plugin-2"].mode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        });
    });

    describe("executeSync lazyToCore", () => {
        it("should sync from lazy settings to disk", async () => {
            // plugin-2 is ALWAYS_ENABLED, but not in enabledPluginsFromDisk
            mockRegistry.enabledPluginsFromDisk = new Set(["plugin-1", "on-demand-plugins"]);

            const result = await feature.executeSync("lazyToCore");

            expect(result.changed).toBe(1);
            expect(mockRegistry.writeCommunityPluginsFile).toHaveBeenCalledWith(expect.arrayContaining(["plugin-2", "on-demand-plugins"]), false);
        });

        it("should do nothing if already in sync", async () => {
            mockCtx.getManifests.mockReturnValue([{ id: "plugin-1", name: "Plugin 1" }]);
            settingsState = {
                plugins: { "plugin-1": { mode: PLUGIN_MODE.ALWAYS_ENABLED } },
            };
            mockRegistry.enabledPluginsFromDisk = new Set(["plugin-1", "on-demand-plugins"]);

            const result = await feature.executeSync("lazyToCore");

            expect(result.changed).toBe(0);
            expect(mockRegistry.writeCommunityPluginsFile).not.toHaveBeenCalled();
        });
    });

    describe("buildSyncPreview", () => {
        it("should build coreToLazy preview", async () => {
            mockRegistry.enabledPluginsFromDisk = new Set(["plugin-1", "on-demand-plugins"]);
            const preview = await feature.buildSyncPreview("coreToLazy");

            expect(preview.label).toContain("community-plugins.json");
            expect(preview.summary).toContain("Will enable: 1");
            expect(preview.summary).toContain("Will disable: 1");
        });

        it("should build lazyToCore preview", async () => {
            mockRegistry.enabledPluginsFromDisk = new Set(["plugin-1", "on-demand-plugins"]);
            const preview = await feature.buildSyncPreview("lazyToCore");

            expect(preview.label).toContain("On-Demand Plugins");
            expect(preview.summary).toContain("Will enable: 1"); // plugin-2
            expect(preview.summary).toContain("Will disable: 1"); // plugin-1
        });
    });
});
