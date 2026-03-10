import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupFeature } from "./backup-feature";

describe("BackupFeature", () => {
    let mockAdapter: any;
    let mockCtx: any;

    beforeEach(() => {
        mockAdapter = {
            exists: vi.fn(),
            mkdir: vi.fn(),
            read: vi.fn(),
            write: vi.fn(),
            list: vi.fn(),
            remove: vi.fn(),
        };

        mockCtx = {
            _plugin: {
                manifest: {
                    dir: "mock/plugin/dir",
                },
            },
            app: {
                vault: {
                    adapter: mockAdapter,
                    getConfigFile: vi.fn().mockImplementation((name) => {
                        if (name === "community-plugins") return "mock/vault/.obsidian/community-plugins.json";
                        return "";
                    }),
                },
                workspace: {
                    on: vi.fn(),
                },
            },
        };
    });

    it("should initialize the backup directory correctly after onload", () => {
        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        // Using any to access private property for testing
        expect((backupFeature as any).backupDir).toBe("mock/plugin/dir/backups");
    });

    it("should create backup folder if it doesn't exist", async () => {
        mockAdapter.exists.mockResolvedValue(false);
        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);

        await backupFeature.ensureBackupFolder();

        expect(mockAdapter.exists).toHaveBeenCalledWith("mock/plugin/dir/backups");
        expect(mockAdapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/backups");
    });

    it("should skip backup if data.json is invalid JSON", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve("{ invalid json ");
            return Promise.resolve("[]");
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if data.json does not contain profiles", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve('{"some_key": "value"}');
            return Promise.resolve("[]");
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if community-plugins.json is not an array", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve('{"profiles": {}}');
            if (path.includes("community-plugins.json")) return Promise.resolve('{"not_array": true}');
            return Promise.resolve("");
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should write backup files if JSON is valid", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles": {}}';
        const validCommunity = '["plugin1", "plugin2"]';

        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve(validData);
            if (path.includes("community-plugins.json")) return Promise.resolve(validCommunity);
            return Promise.resolve("");
        });

        // Mock list returning empty array so rotation doesn't fail
        mockAdapter.list.mockResolvedValue({ folders: [], files: [] });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        await backupFeature.createBackup();

        expect(mockAdapter.write).toHaveBeenCalledTimes(2);

        const dataWriteCall = mockAdapter.write.mock.calls.find((call: any[]) => call[0].includes("data_"));
        const communityWriteCall = mockAdapter.write.mock.calls.find((call: any[]) => call[0].includes("community-plugins_"));

        expect(dataWriteCall).toBeDefined();
        expect(communityWriteCall).toBeDefined();

        expect(dataWriteCall[1]).toBe(validData);
        expect(communityWriteCall[1]).toBe(validCommunity);
    });

    it("should rotate old backups keeping only the latest 3", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles": {}}';
        const validCommunity = "[]";

        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve(validData);
            if (path.includes("community-plugins.json")) return Promise.resolve(validCommunity);
            return Promise.resolve("");
        });

        mockAdapter.list.mockResolvedValue({
            folders: [],
            files: [
                "mock/plugin/dir/backups/data_20260309-100000.json", // Should be removed (1st oldest)
                "mock/plugin/dir/backups/data_20260309-110000.json", // Should be kept
                "mock/plugin/dir/backups/data_20260309-120000.json", // Should be kept
                "mock/plugin/dir/backups/data_20260309-130000.json", // Should be kept
                "mock/plugin/dir/backups/data_20260309-140000.json", // Will be added during createBackup, making total 5

                "mock/plugin/dir/backups/community-plugins_20260309-100000.json", // Should be removed
                "mock/plugin/dir/backups/community-plugins_20260309-110000.json",
                "mock/plugin/dir/backups/community-plugins_20260309-120000.json",
                "mock/plugin/dir/backups/community-plugins_20260309-130000.json",
                "mock/plugin/dir/backups/community-plugins_20260309-140000.json",
            ],
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx, {} as any, {} as any, {} as any);
        // Using any to directly test the rotate logic
        await (backupFeature as any).rotateBackups();

        // Length starts at 5, we keep 3, so we remove 2 data and 2 community = 4 removes
        expect(mockAdapter.remove).toHaveBeenCalledTimes(4);

        // Assert the oldest ones are the ones we requested to remove
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-110000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-110000.json");
    });
});
