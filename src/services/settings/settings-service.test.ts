import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { SettingsService } from "src/services/settings/settings-service";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Storage is unrelated to this behavior; stub it so load() skips lazyOnViews hydration.
vi.mock("../../core/storage");

type MockPlugin = {
    loadData: ReturnType<typeof vi.fn>;
    saveData: ReturnType<typeof vi.fn>;
    app: object;
};

function createService(loadedData: unknown): { service: SettingsService; plugin: MockPlugin } {
    const plugin: MockPlugin = {
        loadData: vi.fn().mockResolvedValue(loadedData),
        saveData: vi.fn().mockResolvedValue(undefined),
        app: {},
    };
    const service = new SettingsService(plugin as unknown as OnDemandPlugin);
    return { service, plugin };
}

// A modern, already-migrated data.json shape (profiles format) so we exercise the
// path where migrateLegacySettings() returns early — the legacy-cache cleanup must
// still run, since it lives in load() rather than in the migration branch.
function migratedDataWith(extra: Record<string, unknown>) {
    return {
        showConsoleLog: false,
        suppressPluginManagementNotice: false,
        profiles: {
            Default: { id: "Default", name: "Default", settings: { ...DEFAULT_DEVICE_SETTINGS } },
        },
        desktopProfileId: "Default",
        mobileProfileId: "Default",
        ...extra,
    };
}

describe("SettingsService legacy command-cache cleanup", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("drops the dead commandCache and commandCacheVersions fields on load", async () => {
        const { service } = createService(
            migratedDataWith({
                commandCache: { "old-plugin": [{ id: "cmd", name: "Cmd" }] },
                commandCacheVersions: { "old-plugin": "1.0.0" },
            }),
        );

        await service.load();

        expect(service.data.commandCache).toBeUndefined();
        expect(service.data.commandCacheVersions).toBeUndefined();
        // The rest of the data must be untouched.
        expect(service.data.profiles.Default).toBeDefined();
    });

    it("is a no-op when the legacy fields are absent", async () => {
        const { service } = createService(migratedDataWith({}));

        await service.load();

        expect(service.data.commandCache).toBeUndefined();
        expect(service.data.commandCacheVersions).toBeUndefined();
    });
});

describe("SettingsService load normalization", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("normalizes invalid profile map fields to empty objects", async () => {
        const { service } = createService(
            migratedDataWith({
                profiles: {
                    Default: {
                        id: "Default",
                        name: "Default",
                        settings: {
                            defaultMode: "lazy",
                            pruneUninstalledEntries: true,
                            showDescriptions: false,
                            plugins: null,
                            lazyOnViews: null,
                            lazyOnFiles: null,
                        },
                    },
                },
            }),
        );

        await service.load();

        expect(service.data.profiles.Default.settings.plugins).toEqual({});
        expect(service.data.profiles.Default.settings.lazyOnViews).toEqual({});
        expect(service.data.profiles.Default.settings.lazyOnFiles).toEqual({});
    });

    it("falls back to a default profile when top-level profile shape is invalid", async () => {
        const plugin: MockPlugin = {
            loadData: vi.fn().mockResolvedValue({
                profiles: null,
                desktopProfileId: null,
                mobileProfileId: null,
            }),
            saveData: vi.fn().mockResolvedValue(undefined),
            app: {},
        };
        const service = new SettingsService(plugin as unknown as OnDemandPlugin);

        await service.load();

        expect(Object.keys(service.data.profiles)).toEqual(["Default"]);
        expect(service.data.desktopProfileId).toBe("Default");
        expect(service.data.mobileProfileId).toBe("Default");
        expect(service.currentProfileId).toBe("Default");
    });
});
