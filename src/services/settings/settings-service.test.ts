import { DEFAULT_DEVICE_SETTINGS, PLUGIN_MODE, SETTINGS_SCHEMA_VERSION } from "src/core/types";
import { loadLocalStorage } from "src/core/storage";
import type OnDemandPlugin from "src/main";
import { SettingsService } from "src/services/settings/settings-service";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function createProfile(id: string, name = id) {
    return { id, name, settings: structuredClone(DEFAULT_DEVICE_SETTINGS) };
}

function createAdapter() {
    return {
        exists: vi.fn(),
        mkdir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ folders: [], files: [] }),
        read: vi.fn(),
        write: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
    };
}

function migratedDataWith(extra: Record<string, unknown> = {}) {
    return {
        showConsoleLog: false,
        profiles: { Default: createProfile("Default") },
        desktopProfileId: "Default",
        mobileProfileId: "Default",
        ...extra,
    };
}

describe("SettingsService loading", () => {
    beforeEach(() => vi.resetAllMocks());

    it("drops the legacy command-cache fields while preserving profiles", async () => {
        const { service } = createService(
            migratedDataWith({
                commandCache: { "old-plugin": [{ id: "cmd", name: "Cmd" }] },
                commandCacheVersions: { "old-plugin": "1.0.0" },
            }),
        );

        await service.load();

        expect(service.data.commandCache).toBeUndefined();
        expect(service.data.commandCacheVersions).toBeUndefined();
        expect(service.data.profiles.Default).toBeDefined();
    });

    it("normalizes omitted optional profile maps", async () => {
        const { service } = createService(
            migratedDataWith({
                profiles: {
                    Default: { id: "Default", name: "Default", settings: { defaultMode: "lazy", pruneUninstalledEntries: true } },
                },
            }),
        );

        await service.load();

        expect(service.data.profiles.Default.settings.plugins).toEqual({});
        expect(service.data.profiles.Default.settings.lazyOnViews).toEqual({});
        expect(service.data.profiles.Default.settings.lazyOnFiles).toEqual({});
    });

    it("blocks invalid profile data instead of replacing it with defaults", async () => {
        const { service, plugin } = createService({ profiles: null, desktopProfileId: null, mobileProfileId: null });

        await expect(service.load()).rejects.toThrow("profiles in data.json are incomplete or damaged");
        expect(plugin.saveData).not.toHaveBeenCalled();
    });

    it("treats an empty profiles map as damaged persisted data", async () => {
        const { service } = createService(migratedDataWith({ profiles: {} }));

        await expect(service.load()).rejects.toThrow("profiles in data.json are incomplete or damaged");
    });

    it("does not drop corrupt entries and continue with partial profile data", async () => {
        const { service } = createService(
            migratedDataWith({
                profiles: {
                    Broken: null,
                    Default: createProfile("Default"),
                },
            }),
        );

        await expect(service.load()).rejects.toThrow("profiles in data.json are incomplete or damaged");
    });

    it("blocks an unknown setting mode instead of normalizing it to a default", async () => {
        const { service } = createService(
            migratedDataWith({
                profiles: { Default: { id: "Default", name: "Default", settings: { defaultMode: "future-mode" } } },
            }),
        );

        await expect(service.load()).rejects.toThrow("profiles in data.json are incomplete or damaged");
    });

    it("blocks malformed legacy device settings before converting them", async () => {
        const { service } = createService({ showConsoleLog: false, desktop: { defaultMode: null, plugins: [] } });

        await expect(service.load()).rejects.toThrow("Legacy settings are incomplete or damaged");
    });

    it("keeps a missing data.json in memory without saving defaults during load", async () => {
        const { service, plugin } = createService(undefined);

        await service.load();

        expect(service.isFirstLoad).toBe(true);
        expect(service.data.profiles.Default).toBeDefined();
        expect(plugin.saveData).not.toHaveBeenCalled();
    });

    it("refuses an unknown schema version without writing it", async () => {
        const { service, plugin } = createService(migratedDataWith({ settingsSchemaVersion: SETTINGS_SCHEMA_VERSION + 1 }));

        await expect(service.load()).rejects.toThrow("newer or unsupported format");
        expect(plugin.saveData).not.toHaveBeenCalled();
    });
});

describe("SettingsService inline persistence", () => {
    beforeEach(() => vi.resetAllMocks());

    it("prefers profiles from data.json and does not inspect stale local profiles", async () => {
        const adapter = createAdapter();
        const inline = createProfile("Inline");
        adapter.exists.mockResolvedValue(true);
        adapter.read.mockResolvedValue(
            JSON.stringify({
                showConsoleLog: false,
                profiles: { Inline: inline },
                desktopProfileId: "Inline",
                mobileProfileId: "Inline",
            }),
        );
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData: vi.fn().mockResolvedValue(undefined),
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);

        await service.load();

        expect(service.data.profiles).toEqual({ Inline: inline });
        expect(adapter.list).not.toHaveBeenCalled();
    });

    it("does not let stale legacy desktop/mobile fields replace inline profiles", async () => {
        const inlineProfile = createProfile("Default");
        inlineProfile.settings.defaultMode = PLUGIN_MODE.LAZY;
        const { service } = createService(
            migratedDataWith({
                profiles: { Default: inlineProfile },
                desktop: { defaultMode: PLUGIN_MODE.ALWAYS_DISABLED },
                mobile: { defaultMode: PLUGIN_MODE.ALWAYS_DISABLED },
            }),
        );

        await service.load();

        expect(service.settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
    });

    it("does not merge stale local storage over inline lazy view rules", async () => {
        const inlineProfile = createProfile("Default");
        inlineProfile.settings.lazyOnViews = { "some-plugin": ["inline-view"] };
        vi.mocked(loadLocalStorage).mockReturnValue({ "some-plugin": ["old-local-view"] });
        const { service } = createService(migratedDataWith({ profiles: { Default: inlineProfile } }));

        await service.load();

        expect(service.settings.lazyOnViews).toEqual({ "some-plugin": ["inline-view"] });
        expect(loadLocalStorage).not.toHaveBeenCalled();
    });

    it("does not restore local view rules when data.json is missing", async () => {
        vi.mocked(loadLocalStorage).mockReturnValue({ "some-plugin": ["old-local-view"] });
        const { service } = createService(undefined);

        await service.load();

        expect(service.settings.lazyOnViews).toEqual({});
        expect(loadLocalStorage).not.toHaveBeenCalled();
    });

    it("blocks a save if a newer synced data.json arrives after load", async () => {
        const adapter = createAdapter();
        let diskData = JSON.stringify(migratedDataWith());
        adapter.exists.mockResolvedValue(true);
        adapter.read.mockImplementation(async () => diskData);
        const saveData = vi.fn().mockResolvedValue(undefined);
        const plugin = {
            app: { vault: { adapter, workspace: { trigger: vi.fn() } } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData,
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();
        diskData = JSON.stringify(
            migratedDataWith({
                profiles: { Synced: createProfile("Synced") },
                desktopProfileId: "Synced",
                mobileProfileId: "Synced",
            }),
        );

        await expect(service.save()).rejects.toThrow("changed on disk after this plugin loaded");
        expect(saveData).not.toHaveBeenCalled();
    });

    it("serializes consecutive saves and stores profiles inline", async () => {
        const adapter = createAdapter();
        let diskData = JSON.stringify(migratedDataWith());
        adapter.exists.mockResolvedValue(true);
        adapter.read.mockImplementation(async () => diskData);
        const trigger = vi.fn();
        const saveData = vi.fn(async (value: unknown) => {
            diskData = JSON.stringify(value);
        });
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData,
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();
        service.data.profiles.Secondary = createProfile("Secondary");

        await Promise.all([service.save(), service.save()]);

        expect(saveData).toHaveBeenCalledTimes(2);
        expect(saveData.mock.calls[0]?.[0]).toHaveProperty("profiles.Secondary");
        expect(saveData.mock.calls[0]?.[0]).not.toHaveProperty("profileStorageVersion");
        expect(trigger).toHaveBeenCalledTimes(2);
    });
});
