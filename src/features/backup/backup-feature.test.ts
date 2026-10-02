import { BackupFeature } from "src/features/backup/backup-feature";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
        _plugin: { manifest: { dir: string }; core: { settingsService: { isFirstLoad: boolean; data: { profiles: Record<string, unknown> } } } };
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
                core: {
                    settingsService: {
                        isFirstLoad: false,
                        data: {
                            profiles: {},
                        },
                    },
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

        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
            if (path.includes("community-plugins.json")) return "[]";
            return "";
        });
        mockAdapter.list.mockResolvedValue({ folders: [], files: [] });
    });

    it("should initialize the backup directory correctly after onload", async () => {
        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        expect((backupFeature as unknown as { backupDir: string }).backupDir).toBe("mock/plugin/dir/backups");
    });

    it("should create backup folder if it doesn't exist", async () => {
        mockAdapter.exists.mockResolvedValue(false);
        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);

        await backupFeature.ensureBackupFolder();

        expect(mockAdapter.exists).toHaveBeenCalledWith("mock/plugin/dir/backups");
        expect(mockAdapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/backups");
    });

    it("should skip backup if data.json is invalid JSON", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return "{ invalid json ";
            return "[]";
        });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if data.json does not contain profiles", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return '{"some_key": "value"}';
            return "[]";
        });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should skip backup if community-plugins.json is not an array", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
            if (path.includes("community-plugins.json")) return '{"not_array": true}';
            return "";
        });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should write backup files if JSON is valid", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
        const validCommunity = '["plugin1", "plugin2"]';

        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return validCommunity;
            return "";
        });

        // Mock list returning empty array so rotation doesn't fail
        mockAdapter.list.mockResolvedValue({ folders: [], files: [] });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).toHaveBeenCalledTimes(2);

        const dataWriteCall = mockAdapter.write.mock.calls.find((call: unknown[]) => String(call[0]).includes("data_"));
        const communityWriteCall = mockAdapter.write.mock.calls.find((call: unknown[]) => String(call[0]).includes("community-plugins_"));

        expect(dataWriteCall).toBeDefined();
        expect(communityWriteCall).toBeDefined();

        expect(dataWriteCall![1]).toBe(validData);
        expect(communityWriteCall![1]).toBe(validCommunity);
    });

    it("should include external profile files in the backup", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profileStorageVersion":1}';
        const validCommunity = "[]";
        const profileContent = '{"id":"Default","name":"Default","settings":{}}';

        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return validCommunity;
            return profileContent;
        });
        mockAdapter.list.mockResolvedValueOnce({ folders: [], files: ["mock/plugin/dir/profiles/Default.json"] }).mockResolvedValueOnce({ folders: [], files: [] });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        const profileWriteCall = mockAdapter.write.mock.calls.find((call: unknown[]) => String(call[0]).includes("profiles_"));
        expect(profileWriteCall).toBeDefined();
        expect(profileWriteCall![1]).toContain('"Default.json"');
        expect(profileWriteCall![1]).toContain(JSON.stringify(profileContent));
    });

    it("does not snapshot stale local profiles when the current data is inline", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return "[]";
            return '{"id":"Old","name":"Old","settings":{}}';
        });
        mockAdapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Old.json"] });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.list).not.toHaveBeenCalledWith("mock/plugin/dir/profiles");
        expect(mockAdapter.write).toHaveBeenCalledTimes(2);
    });

    it("skips backup and rotation when any legacy external profile is invalid", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return '{"profileStorageVersion":1}';
            if (path.includes("community-plugins.json")) return "[]";
            return path.endsWith("Default.json") ? '{"id":"Default","name":"Default","settings":{}}' : "{broken";
        });
        mockAdapter.list.mockResolvedValue({ folders: [], files: ["mock/plugin/dir/profiles/Default.json", "mock/plugin/dir/profiles/Other.json"] });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);
        await backupFeature.createBackup();

        expect(mockAdapter.write).not.toHaveBeenCalled();
        expect(mockAdapter.remove).not.toHaveBeenCalled();
    });

    it("creates distinct backups for concurrent requests with the same clock time", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
        const files = new Set<string>();
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
            if (path.includes("community-plugins.json")) return "[]";
            return "";
        });
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the adapter mock must return a Promise like the vault API.
        mockAdapter.list.mockImplementation((path: string) =>
            Promise.resolve({
                folders: [],
                files: path === "mock/plugin/dir/backups" ? Array.from(files) : [],
            }),
        );
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the adapter mock must return a Promise like the vault API.
        mockAdapter.write.mockImplementation((path: string) => {
            files.add(path);
            return Promise.resolve();
        });
        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);

        try {
            await Promise.all([backupFeature.createBackup(), backupFeature.createBackup()]);
        } finally {
            now.mockRestore();
        }

        const dataBackupPaths = Array.from(files).filter((path) => path.includes("/data_"));
        expect(dataBackupPaths).toHaveLength(2);
        expect(new Set(dataBackupPaths).size).toBe(2);
    });

    it("should create immutable initial-install backup whenever it is missing", async () => {
        // Keep this callback synchronous to satisfy lint rules for void-expected arguments.
        mockAdapter.exists.mockImplementation((path: string) => path === "mock/plugin/dir/backups");

        const validData = '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
        const validCommunity = '["plugin1"]';
        mockAdapter.read.mockImplementation((path: string) => {
            if (path.includes("data.json")) return validData;
            if (path.includes("community-plugins.json")) return validCommunity;
            return "";
        });

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);

        expect(mockAdapter.mkdir).toHaveBeenCalledWith("mock/plugin/dir/backups/initial-install");
        expect(mockAdapter.write).toHaveBeenCalledWith("mock/plugin/dir/backups/initial-install/data.json", validData);
        expect(mockAdapter.write).toHaveBeenCalledWith("mock/plugin/dir/backups/initial-install/community-plugins.json", validCommunity);
        expect(mockAdapter.list).toHaveBeenCalledTimes(1);
        expect(mockAdapter.list).toHaveBeenCalledWith("mock/plugin/dir/backups");
    });

    it("should not overwrite immutable initial-install backup when it already exists", async () => {
        mockAdapter.exists.mockResolvedValue(true);

        const backupFeature = new BackupFeature();
        await backupFeature.onload(mockCtx as never);

        expect(mockAdapter.write).not.toHaveBeenCalled();
    });

    it("should rotate old backups keeping only the latest 3", async () => {
        mockAdapter.exists.mockResolvedValue(true);
        const validData = '{"profiles":{"Default":{"id":"Default","name":"Default","settings":{}}}}';
        const validCommunity = "[]";

        mockAdapter.read.mockImplementation((path: string) => {
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
        await backupFeature.onload(mockCtx as never);
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
