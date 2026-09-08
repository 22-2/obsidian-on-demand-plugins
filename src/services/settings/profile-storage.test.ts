import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { ProfileStorage } from "src/services/settings/profile-storage";
import { SettingsService } from "src/services/settings/settings-service";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/storage");

function createProfile(id = "Default") {
    return {
        id,
        name: id,
        settings: structuredClone(DEFAULT_DEVICE_SETTINGS),
    };
}

function createAdapter() {
    return {
        exists: vi.fn(),
        mkdir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn(),
        read: vi.fn(),
        write: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
    };
}

function createPlugin(adapter: ReturnType<typeof createAdapter>) {
    return {
        app: { vault: { adapter } },
        manifest: { dir: "mock/plugin/dir" },
    } as unknown as OnDemandPlugin;
}

describe("ProfileStorage", () => {
    let adapter: ReturnType<typeof createAdapter>;

    beforeEach(() => {
        adapter = createAdapter();
        adapter.exists.mockResolvedValue(true);
        adapter.list.mockResolvedValue({ folders: [], files: [] });
    });

    it("loads profiles by listing the adapter directory", async () => {
        const profile = createProfile();
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] });
        adapter.read.mockResolvedValue(JSON.stringify(profile));

        const result = await new ProfileStorage(createPlugin(adapter)).load();

        expect(result.available).toBe(true);
        expect(result.filesFound).toBe(true);
        expect(result.profiles).toEqual({ Default: profile });
        expect(adapter.list).toHaveBeenCalledWith("mock/plugin/dir/profiles");
    });

    it("falls back to a profile backup when its main file is corrupt", async () => {
        const profile = createProfile();
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json", "mock/plugin/dir/profiles/Default.json.bak"] });
        adapter.read.mockImplementation(async (path: string) => (path.endsWith(".bak") ? JSON.stringify(profile) : "{broken"));

        const result = await new ProfileStorage(createPlugin(adapter)).load();

        expect(result.profiles.Default).toEqual(profile);
        expect(result.corruptPaths).toEqual([]);
        expect(adapter.read).toHaveBeenNthCalledWith(1, "mock/plugin/dir/profiles/Default.json");
        expect(adapter.read).toHaveBeenNthCalledWith(2, "mock/plugin/dir/profiles/Default.json.bak");
    });

    it("writes a backup before overwriting and removes deleted profile files", async () => {
        adapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Old.json"] });
        adapter.exists.mockImplementation(async (path: string) => path === "mock/plugin/dir/profiles" || path === "mock/plugin/dir/profiles/Default.json");
        adapter.read.mockResolvedValue(JSON.stringify(createProfile()));

        await new ProfileStorage(createPlugin(adapter)).save({ Default: createProfile() });

        expect(adapter.write).toHaveBeenNthCalledWith(1, "mock/plugin/dir/profiles/Default.json.bak", expect.any(String));
        expect(adapter.write).toHaveBeenNthCalledWith(2, "mock/plugin/dir/profiles/Default.json", expect.stringContaining('"id": "Default"'));
        expect(adapter.remove).toHaveBeenCalledWith("mock/plugin/dir/profiles/Old.json");
    });
});

describe("SettingsService external profile migration", () => {
    it("moves legacy profiles out of data.json on first writable load", async () => {
        const adapter = createAdapter();
        adapter.exists.mockResolvedValue(false);
        adapter.list.mockResolvedValue({ folders: [], files: [] });
        const saveData = vi.fn().mockResolvedValue(undefined);
        const plugin = {
            app: { vault: { adapter } },
            manifest: { dir: "mock/plugin/dir" },
            loadData: vi.fn().mockResolvedValue({
                showConsoleLog: false,
                profiles: { Default: createProfile() },
                desktopProfileId: "Default",
                mobileProfileId: "Default",
            }),
            saveData,
        } as unknown as OnDemandPlugin;

        await new SettingsService(plugin).load();

        expect(adapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/profiles");
        expect(adapter.write).toHaveBeenCalledWith("mock/plugin/dir/profiles/Default.json", expect.stringContaining('"id": "Default"'));
        const savedData = saveData.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(savedData.profileStorageVersion).toBe(1);
        expect(savedData).not.toHaveProperty("profiles");
    });
});
