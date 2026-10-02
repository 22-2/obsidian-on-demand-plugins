import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { ProfileStorage } from "src/services/settings/profile-storage";
import { SettingsService } from "src/services/settings/settings-service";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/storage");

function createProfile(id = "Default") {
    return { id, name: id, settings: structuredClone(DEFAULT_DEVICE_SETTINGS) };
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

function createPlugin(adapter: ReturnType<typeof createAdapter>, data: unknown) {
    const saveData = vi.fn().mockResolvedValue(undefined);
    return {
        plugin: {
            app: { vault: { adapter }, workspace: { trigger: vi.fn() } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn().mockResolvedValue(data),
            saveData,
        } as unknown as OnDemandPlugin,
        saveData,
    };
}

describe("ProfileStorage migration reader", () => {
    let adapter: ReturnType<typeof createAdapter>;

    beforeEach(() => {
        vi.resetAllMocks();
        adapter = createAdapter();
        adapter.exists.mockResolvedValue(true);
        adapter.list.mockResolvedValue({ folders: [], files: [] });
    });

    it("reads current profile files by listing the local directory", async () => {
        const profile = createProfile();
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] });
        adapter.read.mockResolvedValue(JSON.stringify(profile));

        const result = await new ProfileStorage(createPlugin(adapter, {}).plugin).load();

        expect(result.available).toBe(true);
        expect(result.filesFound).toBe(true);
        expect(result.profiles).toEqual({ Default: profile });
        expect(adapter.list).toHaveBeenCalledWith("mock/plugin/dir/profiles");
    });

    it("does not recover a corrupt primary from a possibly stale .bak", async () => {
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json", "mock/plugin/dir/profiles/Default.json.bak"] });
        adapter.read.mockImplementation(async (path: string) => (path.endsWith(".bak") ? JSON.stringify(createProfile()) : "{broken"));

        const result = await new ProfileStorage(createPlugin(adapter, {}).plugin).load();

        expect(result.profiles).toEqual({});
        expect(result.corruptPaths).toEqual(["mock/plugin/dir/profiles/Default.json"]);
        expect(adapter.read).toHaveBeenCalledTimes(1);
        expect(adapter.read).toHaveBeenCalledWith("mock/plugin/dir/profiles/Default.json");
    });

    it("migrates a complete 3.5.0 external profile set into data.json", async () => {
        const adapter = createAdapter();
        const oldData = { showConsoleLog: false, profileStorageVersion: 1, desktopProfileId: "Default", mobileProfileId: "Default" };
        const profile = createProfile();
        let dataFile = JSON.stringify(oldData);
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/data.json" || path === "mock/plugin/dir/profiles");
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] });
        adapter.read.mockImplementation(async (path: string) => (path.endsWith("data.json") ? dataFile : JSON.stringify(profile)));
        const { plugin, saveData } = createPlugin(adapter, oldData);
        saveData.mockImplementation((value: unknown) => {
            dataFile = JSON.stringify(value);
            return Promise.resolve();
        });

        await new SettingsService(plugin).load();

        const savedData = JSON.parse(dataFile) as Record<string, unknown>;
        expect(savedData.profiles).toEqual({ Default: profile });
        expect(savedData).not.toHaveProperty("profileStorageVersion");
        expect(savedData.settingsSchemaVersion).toBe(1);
        expect(adapter.write).not.toHaveBeenCalled();
        expect(adapter.remove).not.toHaveBeenCalled();
    });

    it("blocks partial migration when an external primary is corrupt even if .bak is valid", async () => {
        const adapter = createAdapter();
        const oldData = { showConsoleLog: false, profileStorageVersion: 1 };
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/data.json" || path === "mock/plugin/dir/profiles");
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json", "mock/plugin/dir/profiles/Default.json.bak"] });
        adapter.read.mockImplementation(async (path: string) => {
            if (path.endsWith("data.json")) return JSON.stringify(oldData);
            return path.endsWith(".bak") ? JSON.stringify(createProfile()) : "{broken";
        });
        const { plugin, saveData } = createPlugin(adapter, oldData);

        await expect(new SettingsService(plugin).load()).rejects.toThrow("External profiles could not be verified");
        expect(saveData).not.toHaveBeenCalled();
        expect(adapter.read).toHaveBeenCalledTimes(2);
    });

    it("blocks migration when a profile file name and ID do not match", async () => {
        const adapter = createAdapter();
        const oldData = { showConsoleLog: false, profileStorageVersion: 1 };
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/data.json" || path === "mock/plugin/dir/profiles");
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] });
        adapter.read.mockImplementation(async (path: string) => (path.endsWith("data.json") ? JSON.stringify(oldData) : JSON.stringify(createProfile("Other"))));
        const { plugin, saveData } = createPlugin(adapter, oldData);

        await expect(new SettingsService(plugin).load()).rejects.toThrow("External profiles could not be verified");
        expect(saveData).not.toHaveBeenCalled();
        expect(adapter.write).not.toHaveBeenCalled();
    });

    it("stops migration if data.json changes before the inline write", async () => {
        const adapter = createAdapter();
        const oldData = { showConsoleLog: false, profileStorageVersion: 1, desktopProfileId: "Default", mobileProfileId: "Default" };
        const newerData = { showConsoleLog: true, profiles: { Synced: createProfile("Synced") }, desktopProfileId: "Synced", mobileProfileId: "Synced" };
        let dataReads = 0;
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/data.json" || path === "mock/plugin/dir/profiles");
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] });
        adapter.read.mockImplementation(async (path: string) => {
            if (!path.endsWith("data.json")) return JSON.stringify(createProfile());
            dataReads += 1;
            return JSON.stringify(dataReads === 1 ? oldData : newerData);
        });
        const { plugin, saveData } = createPlugin(adapter, oldData);

        await expect(new SettingsService(plugin).load()).rejects.toThrow("changed on disk after this plugin loaded");
        expect(saveData).not.toHaveBeenCalled();
    });

    it("blocks migration when the external folder has no current profile files", async () => {
        const adapter = createAdapter();
        const oldData = { showConsoleLog: false, profileStorageVersion: 1 };
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/data.json" || path === "mock/plugin/dir/profiles");
        adapter.read.mockResolvedValue(JSON.stringify(oldData));
        const { plugin, saveData } = createPlugin(adapter, oldData);

        await expect(new SettingsService(plugin).load()).rejects.toThrow("External profiles could not be verified");
        expect(saveData).not.toHaveBeenCalled();
    });
});
