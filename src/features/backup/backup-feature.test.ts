import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupFeature } from "src/features/backup/backup-feature";

describe("BackupFeature", () => {
    let mockAdapter: {
        exists: ReturnType<typeof vi.fn>;
        mkdir: ReturnType<typeof vi.fn>;
        read: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        list: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
    };
    let mockCtx: {
        _plugin: { manifest: { dir: string } };
        app: {
            vault: {
                adapter: typeof mockAdapter;
                configDir: string;
                getConfigFile: ReturnType<typeof vi.fn>;
            };
            workspace: { on: ReturnType<typeof vi.fn> };
        };
    };

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
                    configDir: "config",
                    getConfigFile: vi.fn().mockImplementation((name) => {
                        if (name === "community-plugins") return "mock/vault/config/community-plugins.json";
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
        backupFeature.onload(mockCtx as never);
        expect((backupFeature as unknown as { backupDir: string }).backupDir).toBe("mock/plugin/dir/backups");
    });

    it("should create backup folder if it doesn't exist", async () => {
        mockAdapter.exists.mockResolvedValue(false);
        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx as never);

        await backupFeature.ensureBackupFolder();

        expect(mockAdapter.exists).toHaveBeenCalledWith("mock/plugin/dir/backups");
        expect(mockAdapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/backups");
    });

    it("should skip backup if data.json is invalid JSON", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation(async (path: string) => {
            if (path.includes("data.json")) return "{ invalid json ";
            return "[]";
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if data.json does not contain profiles", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation(async (path: string) => {
            if (path.includes("data.json")) return '{"some_key": "value"}';
            return "[]";
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if community-plugins.json is not an array", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation(async (path: string) => {
            if (path.includes("data.json")) return '{"profiles": {}}';
            if (path.includes("community-plugins.json")) return '{"not_array": true}';
            return "";
        });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should write backup files if JSON is valid", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles": {}}';
        const validCommunity = '["plugin1", "plugin2"]';

        mockAdapter.read.mockImplementation(async (path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return validCommunity;
            return "";
        });

        // Mock list returning empty array so rotation doesn't fail
        mockAdapter.list.mockResolvedValue({ folders: [], files: [] });

        const backupFeature = new BackupFeature();
        backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).toHaveBeenCalledTimes(2);

        const dataWriteCall = mockAdapter.write.mock.calls.find((call: unknown[]) => String(call[0]).includes("data_"));
        const communityWriteCall = mockAdapter.write.mock.calls.find((call: unknown[]) => String(call[0]).includes("community-plugins_"));

        expect(dataWriteCall).toBeDefined();
        expect(communityWriteCall).toBeDefined();

        expect(dataWriteCall![1]).toBe(validData);
        expect(communityWriteCall![1]).toBe(validCommunity);
    });

    it("should rotate old backups keeping only the latest 3", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles": {}}';
        const validCommunity = "[]";

        mockAdapter.read.mockImplementation(async (path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return validCommunity;
            return "";
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
        backupFeature.onload(mockCtx as never);
        await (backupFeature as unknown as { rotateBackups: () => Promise<void> }).rotateBackups();

        // Length starts at 5, we keep 3, so we remove 2 data and 2 community = 4 removes
        expect(mockAdapter.remove).toHaveBeenCalledTimes(4);

        // Assert the oldest ones are the ones we requested to remove
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/data_20260309-110000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-100000.json");
        expect(mockAdapter.remove).toHaveBeenCalledWith("mock/plugin/dir/backups/community-plugins_20260309-110000.json");
    });
});
