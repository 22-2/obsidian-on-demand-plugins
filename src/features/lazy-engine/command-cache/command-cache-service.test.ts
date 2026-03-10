import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import type { PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import * as storageMs from "src/core/storage";
import * as utilsMs from "src/core/utils";
import { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";

vi.mock("../../../core/utils", () => ({
    isPluginLoaded: vi.fn(),
    isLazyMode: vi.fn(),
}));
vi.mock("../../../core/storage");

describe("CommandCacheService", () => {
    let service: CommandCacheService;
    let mockCtx: any;
    let mockPluginLoader: Mocked<PluginLoader>;

    beforeEach(() => {
        vi.resetAllMocks();

        mockCtx = {
            app: {},
            getManifests: vi.fn().mockReturnValue([{ id: "test-plugin", version: "1.0.0" }]),
            getPluginMode: vi.fn(),
            getCommandPluginId: vi.fn(),
            obsidianCommands: {
                commands: {},
                addCommand: vi.fn().mockImplementation((cmd: any) => {
                    mockCtx.obsidianCommands.commands[cmd.id] = cmd;
                }),
                removeCommand: vi.fn(),
            },
            obsidianPlugins: {
                enabledPlugins: new Set(),
                enablePlugin: vi.fn(),
            },
        };

        mockPluginLoader = {
            waitForPluginLoaded: vi.fn().mockResolvedValue(true),
            runLazyCommand: vi.fn().mockResolvedValue(undefined),
        } as unknown as Mocked<PluginLoader>;

        service = new CommandCacheService(mockCtx as unknown as PluginContext, mockPluginLoader);
    });

    describe("getCommandsForPlugin", () => {
        it("should enable and wait for plugin to load before retrieving commands", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);

            mockCtx.obsidianCommands.commands = {
                "test-cmd-1": { id: "test-cmd-1", name: "My Cmd" },
                "other-cmd": { id: "other-cmd", name: "Other" },
            };
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "test-cmd-1" ? "test-plugin" : "other"));

            const result = await service.getCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianPlugins.enablePlugin).toHaveBeenCalledWith("test-plugin");
            expect(mockPluginLoader.waitForPluginLoaded).toHaveBeenCalledWith("test-plugin");

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
            // Setup cache via refresh
            mockCtx.obsidianCommands.commands = {
                cmd1: { id: "cmd1", name: "Cmd 1" },
            };
            mockCtx.getCommandPluginId.mockReturnValue("test-plugin");
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);

            await service.refreshCommandsForPlugin("test-plugin"); // This populates the internal store

            // Now remove it from obsidianCommands as if it's unloaded
            mockCtx.obsidianCommands.commands = {};

            service.registerCachedCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.addCommand).toHaveBeenCalledTimes(1);
            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0];
            expect(addedCmd.id).toBe("cmd1");

            expect(service.isWrapperCommand("cmd1")).toBe(true);

            // Invoke the callback to test LazyCommand running
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

            // Mock that addCommand added it to the dict
            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0];
            mockCtx.obsidianCommands.commands["cmd1"] = addedCmd;

            service.removeCachedCommandsForPlugin("test-plugin");

            expect(mockCtx.obsidianCommands.removeCommand).toHaveBeenCalledWith("cmd1");
            expect(service.isWrapperCommand("cmd1")).toBe(false);
        });
    });

    describe("ensureCommandsCached", () => {
        it("should do nothing if valid", async () => {
            // Mock store valid state via setup
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

            mockCtx.obsidianCommands.commands = {}; // Now it's missing

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

            // Manually inject it into commands to simulate registration
            const wrapper = (service as any).wrapperCommands.get("cmd1");
            mockCtx.obsidianCommands.commands["cmd1"] = wrapper;

            // Scenario: Now Obsidian has a different command with the same ID
            mockCtx.obsidianCommands.commands["cmd1"] = { id: "cmd1", name: "Real" };

            service.syncCommandWrappersForPlugin("test-plugin");

            expect(service.isWrapperCommand("cmd1")).toBe(false);
            expect((service as any).registeredWrappers.has("cmd1")).toBe(false);
        });
    });

    describe("refreshCommandCache", () => {
        it("should refresh all lazy plugins if force is true", async () => {
            vi.mocked(utilsMs.isLazyMode).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            mockCtx.getPluginMode.mockReturnValue("lazy");

            // Set up a dummy command so that getCommandsForPlugin returns something
            mockCtx.obsidianCommands.commands = { cmd1: { id: "cmd1", name: "Cmd 1" } };
            mockCtx.getCommandPluginId.mockImplementation((id: string) => (id === "cmd1" ? "test-plugin" : "other"));

            const onProgress = vi.fn();

            await service.refreshCommandCache(undefined, true, onProgress);

            expect(onProgress).toHaveBeenCalledTimes(1);
            expect(storageMs.saveLocalStorage).toHaveBeenCalled();
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

            // Mock that it was added by Obsidian
            const addedCmd = mockCtx.obsidianCommands.addCommand.mock.calls[0][0];
            mockCtx.obsidianCommands.commands["cmd1"] = addedCmd;

            service.clear();

            expect(mockCtx.obsidianCommands.removeCommand).toHaveBeenCalledWith("cmd1");
            expect(service.getCachedCommand("cmd1")).toBeUndefined();
        });
    });
});
