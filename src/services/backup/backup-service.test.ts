import { describe, it, expect, vi, beforeEach } from "vitest";

import { BackupService } from "./backup-service";

describe("BackupService", () => {
    let mockAdapter: any;
    let mockCtx: any;
    let mockRegistry: any;

    beforeEach(() => {
        mockAdapter = {
            exists: vi.fn(),
            mkdir: vi.fn(),
            read: vi.fn(),
            write: vi.fn(),
            list: vi.fn(),
            remove: vi.fn()
        };

        mockCtx = {
            _plugin: {
                manifest: {
                    dir: "mock/plugin/dir"
                }
            },
            app: {
                vault: {
                    adapter: mockAdapter
                }
            }
        };

        mockRegistry = {
            getCommunityPluginsConfigFilePath: vi.fn().mockReturnValue("mock/vault/.obsidian/community-plugins.json")
        };
    });

    it("should initialize the backup directory correctly", () => {
        const backupService = new BackupService(mockCtx, mockRegistry);
        // Using any to access private property for testing
        expect((backupService as any).backupDir).toBe("mock/plugin/dir/backups");
    });

    it("should create backup folder if it doesn't exist", async () => {
        mockAdapter.exists.mockResolvedValue(false);
        const backupService = new BackupService(mockCtx, mockRegistry);
        
        await backupService.ensureBackupFolder();
        
        expect(mockAdapter.exists).toHaveBeenCalledWith("mock/plugin/dir/backups");
        expect(mockAdapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/backups");
    });

    it("should skip backup if data.json is invalid JSON", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve("{ invalid json ");
            return Promise.resolve("[]");
        });

        const backupService = new BackupService(mockCtx, mockRegistry);
        await backupService.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if data.json does not contain profiles", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve('{"some_key": "value"}');
            return Promise.resolve("[]");
        });

        const backupService = new BackupService(mockCtx, mockRegistry);
        await backupService.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if community-plugins.json is not an array", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return Promise.resolve('{"profiles": {}}');
            if (path.includes("community-plugins.json")) return Promise.resolve('{"not_array": true}');
            return Promise.resolve("");
        });

        const backupService = new BackupService(mockCtx, mockRegistry);
        await backupService.createBackup();

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

        const backupService = new BackupService(mockCtx, mockRegistry);
        await backupService.createBackup();

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
        const validCommunity = '[]';
        
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
            ]
        });

        const backupService = new BackupService(mockCtx, mockRegistry);
        // Using any to directly test the rotate logic
        await (backupService as any).rotateBackups();

        // Length starts at 5, we keep 3, so we remove 2 data and 2 community = 4 removes
        expect(mockAdapter.remove).toHaveBeenCalledTimes(4);
        
        // Assert the oldest ones are the ones we requested to remove
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-110000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-110000.json");
    });
});
