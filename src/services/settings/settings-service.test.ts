import { Platform } from "obsidian";
import { DEFAULT_DEVICE_SETTINGS, PLUGIN_MODE, SETTINGS_SCHEMA_VERSION } from "src/core/types";
import type { LazySettings } from "src/core/types";
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
        process: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
    };
}

/** Backs the adapter with one in-memory data.json, mirroring adapter.process (read, transform, write in one step). */
function useDiskFile(adapter: ReturnType<typeof createAdapter>, initial: string) {
    const disk = { data: initial };
    adapter.exists.mockResolvedValue(true);
    adapter.read.mockImplementation(async () => disk.data);
    adapter.process.mockImplementation(async (_path: string, fn: (data: string) => string) => (disk.data = fn(disk.data)));
    return disk;
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

    describe("unsaved draft prompt", () => {
        const profileWith = (settings: Record<string, unknown>) => ({ Default: { id: "Default", name: "Default", settings: { defaultMode: "lazy", ...settings } } });

        it("adopts a value pre-release builds kept on the active profile and removes it from profiles", async () => {
            const { service } = createService(migratedDataWith({ profiles: profileWith({ restoreDraftBehavior: "discard" }) }));
            await service.load();
            expect(service.data.restoreDraftBehavior).toBe("discard");
            expect(service.data.profiles.Default.settings).not.toHaveProperty("restoreDraftBehavior");
        });

        it("keeps the shared value over a leftover profile value", async () => {
            const { service } = createService(migratedDataWith({ restoreDraftBehavior: "restore", profiles: profileWith({ restoreDraftBehavior: "discard" }) }));
            await service.load();
            expect(service.data.restoreDraftBehavior).toBe("restore");
            expect(service.data.profiles.Default.settings).not.toHaveProperty("restoreDraftBehavior");
        });

        it.each([undefined, "sometimes", 1])("falls back to asking for a missing or unknown value (%s)", async (value) => {
            const { service } = createService(migratedDataWith({ restoreDraftBehavior: value, profiles: profileWith({}) }));
            await service.load();
            expect(service.data.restoreDraftBehavior).toBe("ask");
        });
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

describe("SettingsService legacy profile migration", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        Platform.isMobile = false;
    });

    it("migrates dual desktop and mobile settings and hydrates legacy local view rules", async () => {
        vi.mocked(loadLocalStorage).mockReturnValue({ "local-plugin": ["local-view"] });
        const { service, plugin } = createService({
            showConsoleLog: false,
            dualConfigs: true,
            desktop: {
                ...structuredClone(DEFAULT_DEVICE_SETTINGS),
                defaultMode: PLUGIN_MODE.LAZY,
                lazyOnViews: { "shared-plugin": ["desktop-view"] },
            },
            mobile: {
                ...structuredClone(DEFAULT_DEVICE_SETTINGS),
                defaultMode: PLUGIN_MODE.ALWAYS_DISABLED,
                lazyOnViews: { "shared-plugin": ["mobile-view"] },
            },
        });

        await service.load();

        expect(Object.keys(service.data.profiles)).toEqual(["Default", "mobile"]);
        expect(service.data.profiles.Default.name).toBe("Default (desktop)");
        expect(service.data.profiles.mobile.name).toBe("Mobile");
        expect(service.settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(service.settings.lazyOnViews).toEqual({ "shared-plugin": ["desktop-view"], "local-plugin": ["local-view"] });
        expect(service.data).not.toHaveProperty("desktop");
        expect(service.data).not.toHaveProperty("mobile");
        expect(loadLocalStorage).toHaveBeenCalledWith(plugin.app, "lazyOnViews");
    });

    it("uses the mobile profile when the mobile platform is active", async () => {
        Platform.isMobile = true;
        try {
            const { service } = createService({
                showConsoleLog: false,
                dualConfigs: true,
                desktop: { ...structuredClone(DEFAULT_DEVICE_SETTINGS), defaultMode: PLUGIN_MODE.LAZY },
                mobile: { ...structuredClone(DEFAULT_DEVICE_SETTINGS), defaultMode: PLUGIN_MODE.ALWAYS_DISABLED },
            });

            await service.load();

            expect(service.currentProfileId).toBe("mobile");
            expect(service.settings.defaultMode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        } finally {
            Platform.isMobile = false;
        }
    });

    it("migrates a single legacy config when dual configs are disabled", async () => {
        const { service } = createService({
            showConsoleLog: false,
            dualConfigs: false,
            desktop: { ...structuredClone(DEFAULT_DEVICE_SETTINGS), defaultMode: PLUGIN_MODE.LAZY },
            mobile: { ...structuredClone(DEFAULT_DEVICE_SETTINGS), defaultMode: PLUGIN_MODE.ALWAYS_DISABLED },
        });

        await service.load();

        expect(Object.keys(service.data.profiles)).toEqual(["Default"]);
        expect(service.settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(service.data.mobileProfileId).toBe("Default");
        expect(service.data).not.toHaveProperty("dualConfigs");
    });
});

describe("SettingsService profile operations", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        Platform.isMobile = false;
    });

    it("switches, renames, and deletes profiles while updating device defaults", async () => {
        const profiles = {
            Default: createProfile("Default"),
            Work: createProfile("Work"),
        };
        const { service } = createService(migratedDataWith({ profiles }));
        await service.load();

        service.switchProfile("Work");
        service.setDeviceDefault("Work", "mobile");
        service.renameProfile("Work", "Writing");
        service.deleteProfile("Default");

        expect(service.currentProfileId).toBe("Work");
        expect(service.data.desktopProfileId).toBe("Work");
        expect(service.data.mobileProfileId).toBe("Work");
        expect(service.data.profiles.Work.name).toBe("Writing");
        expect(service.data.profiles).toEqual({ Work: profiles.Work });
        expect(() => service.switchProfile("missing")).toThrow("Profile missing not found");
        expect(() => service.deleteProfile("Work")).toThrow("Cannot delete the last profile");
    });

    it("rejects deleting the active profile and ignores unknown device defaults", async () => {
        const { service } = createService(migratedDataWith({ profiles: { Default: createProfile("Default"), Work: createProfile("Work") } }));
        await service.load();

        expect(() => service.deleteProfile("Default")).toThrow("Cannot delete the active profile");
        service.setDeviceDefault("missing", "desktop");
        expect(service.data.desktopProfileId).toBe("Default");
    });

    it("creates a deep copy of the requested source profile", async () => {
        const source = createProfile("Default");
        source.settings.lazyOnFiles = { "sample-plugin": { suffixes: [".md"] } };
        const { service } = createService(migratedDataWith({ profiles: { Default: source } }));
        await service.load();
        vi.stubGlobal("activeWindow", { crypto: { randomUUID: () => "created-profile" } });
        try {
            const createdId = service.createProfile("Copy", "Default");
            service.data.profiles[createdId].settings.lazyOnFiles["sample-plugin"].suffixes?.push(".txt");

            expect(createdId).toBe("created-profile");
            expect(service.data.profiles[createdId].name).toBe("Copy");
            expect(source.settings.lazyOnFiles["sample-plugin"]).toEqual({ suffixes: [".md"] });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("creates a profile with defaults when the requested source does not exist", async () => {
        const { service } = createService(migratedDataWith());
        await service.load();
        vi.stubGlobal("activeWindow", { crypto: { randomUUID: () => "default-profile" } });
        try {
            const createdId = service.createProfile("Fresh", "missing");

            expect(service.data.profiles[createdId].settings).toEqual(DEFAULT_DEVICE_SETTINGS);
            expect(service.data.profiles[createdId].settings).not.toBe(DEFAULT_DEVICE_SETTINGS);
        } finally {
            vi.unstubAllGlobals();
        }
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
        const disk = useDiskFile(adapter, JSON.stringify(migratedDataWith()));
        const trigger = vi.fn();
        const saveData = vi.fn();
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

        expect(adapter.process).toHaveBeenCalledTimes(2);
        expect(saveData).not.toHaveBeenCalled();
        expect(JSON.parse(disk.data)).toHaveProperty("profiles.Secondary");
        expect(JSON.parse(disk.data)).not.toHaveProperty("profileStorageVersion");
        expect(trigger).toHaveBeenCalledTimes(2);
    });

    it("does not overwrite a data.json that changes between the check and the write", async () => {
        const adapter = createAdapter();
        const disk = useDiskFile(adapter, JSON.stringify(migratedDataWith()));
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData: vi.fn(),
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();
        const synced = JSON.stringify(migratedDataWith({ showConsoleLog: true }));
        // Simulate Sync writing data.json after the pre-save read but before the write.
        adapter.process.mockImplementationOnce(async (_path: string, fn: (data: string) => string) => (disk.data = fn(synced)));

        await expect(service.save()).rejects.toThrow("changed on disk after this plugin loaded");
        expect(disk.data).not.toBe(synced);
        await expect(service.save()).rejects.toThrow("cannot be saved");
    });

    it("creates data.json with adapter.write when it does not exist yet", async () => {
        const adapter = createAdapter();
        adapter.exists.mockResolvedValue(false);
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData: vi.fn(),
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();

        await service.save();

        expect(adapter.process).not.toHaveBeenCalled();
        expect(adapter.write).toHaveBeenCalledWith("mock/plugin/dir/data.json", expect.stringContaining('"profiles"'));
    });

    it("persists an explicit snapshot without including or replacing the live plugin draft", async () => {
        const adapter = createAdapter();
        const disk = useDiskFile(adapter, JSON.stringify(migratedDataWith()));
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            saveData: vi.fn(),
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();
        const saved = structuredClone(service.data);
        saved.showConsoleLog = true;
        service.settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };

        await service.save(saved);
        const persisted = JSON.parse(disk.data) as LazySettings;
        expect(persisted.profiles.Default.settings.plugins.foo).toBeUndefined();
        expect(persisted.showConsoleLog).toBe(true);
        expect(service.settings.plugins.foo.mode).toBe(PLUGIN_MODE.LAZY);
        await service.save();
        expect((JSON.parse(disk.data) as LazySettings).profiles.Default.settings.plugins.foo.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("refuses to save before settings have loaded", async () => {
        const { service, plugin } = createService(undefined);

        await expect(service.save()).rejects.toThrow("Settings cannot be saved until a valid settings file is loaded.");
        expect(plugin.saveData).not.toHaveBeenCalled();
    });

    it("blocks saving when the persisted data becomes unreadable", async () => {
        const adapter = createAdapter();
        adapter.exists.mockResolvedValue(true);
        adapter.read.mockResolvedValueOnce(JSON.stringify(migratedDataWith())).mockRejectedValueOnce(new Error("read failed"));
        const saveData = vi.fn().mockResolvedValue(undefined);
        const plugin = {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn(),
            saveData,
        } as unknown as OnDemandPlugin;
        const service = new SettingsService(plugin);
        await service.load();

        await expect(service.save()).rejects.toThrow("changed into an unreadable state");
        expect(saveData).not.toHaveBeenCalled();
    });

    it("blocks saving when the in-memory profile map becomes invalid", async () => {
        const { service, plugin } = createService(migratedDataWith());
        await service.load();
        service.data.profiles = {};

        await expect(service.save()).rejects.toThrow("in-memory profiles are incomplete");
        expect(plugin.saveData).not.toHaveBeenCalled();
    });
});
