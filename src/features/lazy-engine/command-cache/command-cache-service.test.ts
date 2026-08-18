import type { PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import * as storageMs from "src/core/storage";
import * as utilsMs from "src/core/utils";
import { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/utils", () => ({
    isPluginLoaded: vi.fn(),
    isLazyMode: vi.fn(),
}));
vi.mock("../../../core/storage");

type MockCtx = {
    app: object;
    getManifests: ReturnType<typeof vi.fn>;
    getPluginMode: ReturnType<typeof vi.fn>;
    getCommandPluginId: ReturnType<typeof vi.fn>;
    obsidianCommands: {
        commands: Record<string, unknown>;
        addCommand: ReturnType<typeof vi.fn>;
        removeCommand: ReturnType<typeof vi.fn>;
    };
    obsidianPlugins: {
        enabledPlugins: Set<string>;
        enablePlugin: ReturnType<typeof vi.fn>;
        disablePlugin: ReturnType<typeof vi.fn>;
    };
};

describe("CommandCacheService", () => {
    let service: CommandCacheService;
    let mockCtx: MockCtx;
    let mockPluginLoader: {
        waitForPluginLoaded: ReturnType<typeof vi.fn>;
        runLazyCommand: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.resetAllMocks();

        mockCtx = {
            app: {},
            getManifests: vi.fn().mockReturnValue([{ id: "test-plugin", version: "1.0.0" }]),
            getPluginMode: vi.fn(),
            getCommandPluginId: vi.fn(),
            obsidianCommands: {
                commands: {},
                addCommand: vi.fn().mockImplementation((cmd: { id: string }) => {
                    mockCtx.obsidianCommands.commands[cmd.id] = cmd;
                }),
                removeCommand: vi.fn().mockImplementation((id: string) => {
                    delete mockCtx.obsidianCommands.commands[id];
                }),
            },
            obsidianPlugins: {
                enabledPlugins: new Set(),
                enablePlugin: vi.fn(),
                disablePlugin: vi.fn(),
            },
        };

        mockPluginLoader = {
            waitForPluginLoaded: vi.fn().mockResolvedValue(true),
            runLazyCommand: vi.fn().mockResolvedValue(undefined),
        };

        service = new CommandCacheService(mockCtx as unknown as PluginContext, mockPluginLoader as unknown as PluginLoader);
    });

    describe("getCommandsForPlugin", () => {
        it("should enable plugin and snapshot commands even if the loaded flag lags behind registration", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);

            mockCtx.obsidianCommands.commands = {
                "test-cmd-1": { id: "test-cmd-1", name: "My Cmd" },
                "other-cmd": { id: "other-cmd", name: "Other" },
            };
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "test-cmd-1" ? "test-plugin" : "other"));

            const result = await service.getCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianPlugins.enablePlugin).toHaveBeenCalledWith("test-plugin");
            expect(mockPluginLoader.waitForPluginLoaded).not.toHaveBeenCalled();

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("test-cmd-1");
            expect(result[0].pluginId).toBe("test-plugin");
        });

        it("should skip enabling if plugin is already enabled", async () => {
            mockCtx.obsidianPlugins.enabledPlugins.add("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.getCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianPlugins.enablePlugin).not.toHaveBeenCalled();
            expect(mockPluginLoader.waitForPluginLoaded).not.toHaveBeenCalled();
        });
    });

    describe("registerCachedCommandsForPlugin", () => {
        it("should register wrapper commands when cached commands exist and obsidian does not have them", async () => {
            mockCtx.obsidianCommands.commands = {
                cmd1: { id: "cmd1", name: "Cmd 1" },
            };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.refreshCommandsForPlugin("test-plugin");
            mockCtx.obsidianCommands.commands = {};

            service.registerCachedCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.addCommand).toHaveBeenCalledTimes(1);
            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0] as { id: string; callback: () => Promise<void> };
            expect(addedCmd.id).toBe("cmd1");
            expect(service.isWrapperCommand("cmd1")).toBe(true);

            await addedCmd.callback();
            expect(mockPluginLoader.runLazyCommand).toHaveBeenCalledWith("cmd1");
        });

        it("should not register wrapper if command is already registered by real plugin", async () => {
            mockCtx.obsidianCommands.commands = {
                cmd1: { id: "cmd1", name: "Cmd 1" },
            };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.refreshCommandsForPlugin("test-plugin");
            service.registerCachedCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.addCommand).not.toHaveBeenCalled();
        });
    });

    describe("removeCachedCommandsForPlugin", () => {
        it("should remove registered wrappers", async () => {
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.refreshCommandsForPlugin("test-plugin");
            mockCtx.obsidianCommands.commands = {};
            service.registerCachedCommandsForPlugin("test-plugin");

            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0] as { id: string };
            mockCtx.obsidianCommands.commands.cmd1 = addedCmd;

            service.removeCachedCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.removeCommand).toHaveBeenCalledWith("cmd1");
            expect(service.isWrapperCommand("cmd1")).toBe(false);
        });
    });

    describe("ensureCommandsCached", () => {
        it("should do nothing if valid", async () => {
            vi.mocked(storageMs.loadLocalStorage).mockImplementation((app, key) => {
                if (key === "commandCache") return { "test-plugin": [{ id: "cmd1" }] };
                if (key === "commandCacheVersions") return { "test-plugin": "1.0.0" };
                return null;
            });
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            await service.refreshCommandsForPlugin("test-plugin");

            vi.clearAllMocks();

            await service.ensureCommandsCached("test-plugin");

            expect(mockCtx.obsidianPlugins.enablePlugin).not.toHaveBeenCalled();
        });
    });

    describe("syncCommandWrappersForPlugin", () => {
        it("should register wrapper if missing from obsidian commands", async () => {
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.refreshCommandsForPlugin("test-plugin");

            mockCtx.obsidianCommands.commands = {};
            service.syncCommandWrappersForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.addCommand).toHaveBeenCalled();
        });

        it("should cleanup wrapper if different command exists with same ID", async () => {
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            await service.refreshCommandsForPlugin("test-plugin");

            mockCtx.obsidianCommands.commands = {};
            service.registerCachedCommandsForPlugin("test-plugin");

            const wrapper = (service as unknown as { wrapperCommands: Map<string, unknown> }).wrapperCommands.get("cmd1");
            mockCtx.obsidianCommands.commands.cmd1 = wrapper;
            mockCtx.obsidianCommands.commands.cmd1 = { id: "cmd1", name: "Real" };

            service.syncCommandWrappersForPlugin("test-plugin");

            expect(service.isWrapperCommand("cmd1")).toBe(false);
            expect((service as unknown as { registeredWrappers: Set<string> }).registeredWrappers.has("cmd1")).toBe(false);
        });
    });

    describe("refreshCommandCache", () => {
        it("should refresh all lazy plugins if force is true", async () => {
            vi.mocked(utilsMs.isLazyMode).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            mockCtx.getPluginMode.mockReturnValue("lazy");

            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "cmd1" ? "test-plugin" : "other"));

            const onProgress = vi.fn();
            await service.refreshCommandCache(undefined, true, onProgress);

            expect(onProgress).toHaveBeenCalledTimes(1);
            expect(storageMs.saveLocalStorage).toHaveBeenCalled();
        });
    });

    describe("forceReloadPluginCache", () => {
        it("should remove and re-register wrappers when wrapper commands were active", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");

            await service.refreshCommandsForPlugin("test-plugin");

            mockCtx.obsidianCommands.commands = {};
            service.registerCachedCommandsForPlugin("test-plugin");

            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0] as { id: string };
            mockCtx.obsidianCommands.commands.cmd1 = addedCmd;

            await service.forceReloadPluginCache("test-plugin");

            expect(mockCtx.obsidianCommands.removeCommand).toHaveBeenCalledWith("cmd1");
            expect(mockCtx.obsidianCommands.addCommand).toHaveBeenCalledTimes(2);
            expect(storageMs.saveLocalStorage).toHaveBeenCalled();
        });

        it("should refresh and persist without registering wrappers when none were active", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");

            await service.refreshCommandsForPlugin("test-plugin");

            vi.clearAllMocks();

            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1 updated" } };
            await service.forceReloadPluginCache("test-plugin");

            expect(mockCtx.obsidianCommands.removeCommand).not.toHaveBeenCalled();
            expect(mockCtx.obsidianCommands.addCommand).not.toHaveBeenCalled();
            expect(storageMs.saveLocalStorage).toHaveBeenCalled();
        });
    });

    describe("stale command cache (plugin version changed)", () => {
        // Simulates a cache built while test-plugin was 0.9.0; the manifest now reports 1.0.0.
        const seedStorage = (cachedVersion: string) => {
            vi.mocked(storageMs.loadLocalStorage).mockImplementation((_app, key) => {
                if (key === "commandCache") return { "test-plugin": [{ id: "old-cmd", name: "Old Cmd" }] };
                if (key === "commandCacheVersions") return { "test-plugin": cachedVersion };
                return null;
            });
        };

        beforeEach(() => {
            vi.mocked(utilsMs.isLazyMode).mockReturnValue(true);
            mockCtx.getPluginMode.mockReturnValue("lazy");
        });

        it("registerCachedCommands skips wrappers when the cached version mismatches", () => {
            seedStorage("0.9.0");
            service.loadFromData();

            service.registerCachedCommands();

            expect(mockCtx.obsidianCommands.addCommand).not.toHaveBeenCalled();
        });

        it("registerCachedCommands registers wrappers when the cached version matches", () => {
            seedStorage("1.0.0");
            service.loadFromData();

            service.registerCachedCommands();

            expect(mockCtx.obsidianCommands.addCommand).toHaveBeenCalledTimes(1);
            expect((mockCtx.obsidianCommands.addCommand.mock.calls[0][0] as { id: string }).id).toBe("old-cmd");
        });

        it("getStaleCachedPluginIds lists plugins whose cached version mismatches", () => {
            seedStorage("0.9.0");
            service.loadFromData();

            expect(service.getStaleCachedPluginIds()).toEqual(["test-plugin"]);
        });

        it("getStaleCachedPluginIds is empty when versions match", () => {
            seedStorage("1.0.0");
            service.loadFromData();

            expect(service.getStaleCachedPluginIds()).toEqual([]);
        });

        it("refreshStaleCacheForPlugin re-snapshots renamed command IDs and restores the disabled state", async () => {
            seedStorage("0.9.0");
            service.loadFromData();

            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "new-cmd" ? "test-plugin" : "other"));
            // The plugin update renamed old-cmd → new-cmd; enabling registers only the new ID.
            mockCtx.obsidianPlugins.enablePlugin.mockImplementation(() => {
                mockCtx.obsidianCommands.commands = { "new-cmd": { id: "new-cmd", name: "New Cmd" } };
            });
            mockCtx.obsidianPlugins.disablePlugin.mockImplementation(() => {
                mockCtx.obsidianCommands.commands = {};
            });

            await service.refreshStaleCacheForPlugin("test-plugin");

            expect(mockCtx.obsidianPlugins.enablePlugin).toHaveBeenCalledWith("test-plugin");
            // The plugin was disabled before the snapshot, so lazy loading must be restored.
            expect(mockCtx.obsidianPlugins.disablePlugin).toHaveBeenCalledWith("test-plugin");
            expect(storageMs.saveLocalStorage).toHaveBeenCalled();

            // The removed ID must not survive the refresh, or its wrapper would come back
            // on the next startup via persist()/loadFromData().
            expect(service.getCachedCommand("old-cmd")).toBeUndefined();

            const addedIds = mockCtx.obsidianCommands.addCommand.mock.calls.map((call) => (call[0] as { id: string }).id);
            expect(addedIds).toEqual(["new-cmd"]);
        });

        it("refreshStaleCacheForPlugin keeps the plugin enabled if it was enabled beforehand", async () => {
            seedStorage("0.9.0");
            service.loadFromData();

            mockCtx.obsidianPlugins.enabledPlugins.add("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            mockCtx.obsidianCommands.commands = { "new-cmd": { id: "new-cmd", name: "New Cmd" } };
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "new-cmd" ? "test-plugin" : "other"));

            await service.refreshStaleCacheForPlugin("test-plugin");

            expect(mockCtx.obsidianPlugins.disablePlugin).not.toHaveBeenCalled();
        });

        it("refreshStaleCacheForPlugin does NOT bump version when plugin fails to load", async () => {
            seedStorage("0.9.0");
            service.loadFromData();

            // 1st: isPluginReadyForCommandSnapshot → true (skip waitForPluginLoaded).
            // 2nd: pluginLoaded check → false (plugin not actually loaded).
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValueOnce(true).mockReturnValueOnce(false);
            mockCtx.getCommandPluginId.mockReturnValue("other");

            await service.refreshStaleCacheForPlugin("test-plugin");

            // Version must NOT be bumped when plugin fails to load, so the next
            // startup will retry the refresh (issue #6).
            expect(storageMs.saveLocalStorage).not.toHaveBeenCalledWith(
                mockCtx.app,
                "commandCacheVersions",
                expect.anything(),
            );
            expect(service.getCachedCommand("old-cmd")).toBeDefined();
            // Stale wrappers must not be registered: the cached command IDs may
            // no longer exist in the current plugin version (issue #6).
            expect(mockCtx.obsidianCommands.addCommand).not.toHaveBeenCalled();
        });

        it("refreshStaleCacheForPlugin bumps version when plugin loads but has no commands", async () => {
            seedStorage("0.9.0");
            service.loadFromData();

            // Plugin loads successfully but registers no commands.
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            mockCtx.getCommandPluginId.mockReturnValue("other");

            await service.refreshStaleCacheForPlugin("test-plugin");

            // Version SHOULD be bumped when plugin loads but has no commands,
            // so we do not retry on every startup.
            expect(storageMs.saveLocalStorage).toHaveBeenCalledWith(
                mockCtx.app,
                "commandCacheVersions",
                { "test-plugin": "1.0.0" },
            );
            expect(mockCtx.obsidianCommands.addCommand).not.toHaveBeenCalled();
        });
    });

    describe("clear", () => {
        it("should remove all wrappers and clear store", async () => {
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1" } };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            await service.refreshCommandsForPlugin("test-plugin");

            mockCtx.obsidianCommands.commands = {};
            service.registerCachedCommandsForPlugin("test-plugin");

            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0] as { id: string };
            mockCtx.obsidianCommands.commands.cmd1 = addedCmd;

            service.clear();

            expect(mockCtx.obsidianCommands.removeCommand).toHaveBeenCalledWith("cmd1");
            expect(service.getCachedCommand("cmd1")).toBeUndefined();
        });
    });
});
