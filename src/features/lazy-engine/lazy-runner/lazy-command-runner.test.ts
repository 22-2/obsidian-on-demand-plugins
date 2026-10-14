import { EventEmitter } from "node:events";
import { Notice } from "obsidian";
import pWaitFor from "p-wait-for";
import type { CommandRegistry } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import * as utilsMs from "src/core/utils";
import { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/utils", () => ({
    isPluginLoaded: vi.fn(),
    isPluginEnabled: vi.fn(),
}));
vi.mock("p-wait-for");

describe("LazyCommandRunner", () => {
    let runner: LazyCommandRunner;
    let mockCtx: {
        app: { lastEvent: unknown; workspace?: EventEmitter; viewRegistry?: EventEmitter };
        obsidianPlugins: {
            enabledPlugins: Set<string>;
            enablePlugin: ReturnType<typeof vi.fn>;
        };
        getData: ReturnType<typeof vi.fn>;
    };
    let mockRegistry: {
        getCachedCommand: ReturnType<typeof vi.fn>;
        syncCommandWrappersForPlugin: ReturnType<typeof vi.fn>;
        isWrapperCommand: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.resetAllMocks();
        (Notice as unknown as { clearMessages: () => void }).clearMessages();

        mockCtx = {
            app: {
                lastEvent: null,
                workspace: new EventEmitter(),
            },
            obsidianPlugins: {
                enabledPlugins: new Set(),
                enablePlugin: vi.fn().mockResolvedValue(undefined),
            },
            getData: vi.fn().mockReturnValue({ showConsoleLog: false }),
        };

        mockRegistry = {
            getCachedCommand: vi.fn(),
            syncCommandWrappersForPlugin: vi.fn(),
            isWrapperCommand: vi.fn(),
        };

        runner = new LazyCommandRunner(mockCtx as unknown as PluginContext);
        runner.setCommandRegistry(mockRegistry as unknown as CommandRegistry);
    });

    describe("ensurePluginLoaded", () => {
        it("reuses a CLI-loaded plugin absent from the enabled set", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(false);

            expect(await runner.ensurePluginLoaded("graph-analysis-ex")).toBe(true);
            expect(mockCtx.obsidianPlugins.enablePlugin).not.toHaveBeenCalled();
            expect(mockRegistry.syncCommandWrappersForPlugin).toHaveBeenCalledWith("graph-analysis-ex");
        });

        it("should return true if plugin is already loaded and enabled", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(true);

            const result = await runner.ensurePluginLoaded("test-plugin");

            expect(result).toBe(true);
            expect(mockRegistry.syncCommandWrappersForPlugin).toHaveBeenCalledWith("test-plugin");
            expect(mockCtx.obsidianPlugins.enablePlugin).not.toHaveBeenCalled();
        });

        it("should enable and wait for plugin if not loaded/enabled", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);
            vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(false);
            vi.mocked(pWaitFor).mockResolvedValue(undefined);

            // After enablePlugin, next check should be true
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValueOnce(false).mockReturnValue(true);

            const result = await runner.ensurePluginLoaded("test-plugin");

            expect(result).toBe(true);
            expect(mockCtx.obsidianPlugins.enablePlugin).toHaveBeenCalledWith("test-plugin");
            expect(mockRegistry.syncCommandWrappersForPlugin).toHaveBeenCalledWith("test-plugin");
        });

        it("should return false if enablePlugin or loading fails", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);
            mockCtx.obsidianPlugins.enablePlugin.mockRejectedValue(new Error("Fail"));

            const result = await runner.ensurePluginLoaded("test-plugin");

            expect(result).toBe(false);
        });

        it("should return false if the plugin does not finish loading", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);
            vi.mocked(pWaitFor).mockRejectedValue(new Error("timed out"));

            const result = await runner.ensurePluginLoaded("test-plugin");

            expect(result).toBe(false);
            expect(mockRegistry.syncCommandWrappersForPlugin).not.toHaveBeenCalled();
        });

        it("should use mutex to serialize multiple calls for same plugin", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);
            vi.mocked(pWaitFor).mockResolvedValue(undefined);

            // First call will trigger enablePlugin.
            // Second call (serialized by mutex) should see it's already loaded and skip enablePlugin.
            mockCtx.obsidianPlugins.enablePlugin.mockReturnValue(
                new Promise<void>((resolve) =>
                    window.setTimeout(() => {
                        vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
                        vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(true);
                        resolve();
                    }, 50),
                ),
            );

            // Start both concurrently
            const p1 = runner.ensurePluginLoaded("test-plugin");
            const p2 = runner.ensurePluginLoaded("test-plugin");

            await Promise.all([p1, p2]);

            // Total calls should be 1
            expect(mockCtx.obsidianPlugins.enablePlugin).toHaveBeenCalledTimes(1);
        });
    });

    describe("runLazyCommand", () => {
        it("should show notice on cache miss", async () => {
            mockRegistry.getCachedCommand.mockReturnValue(undefined);

            await runner.runLazyCommand("unknown");

            const notice = Notice as unknown as { messages: string[] };
            expect(notice.messages.length).toBe(1);
            expect(notice.messages[0]).toContain("unknown");
            expect(notice.messages[0]).toContain("Open tools");
            expect(mockCtx.obsidianPlugins.enablePlugin).not.toHaveBeenCalled();
        });

        it("should load plugin and execute command", async () => {
            mockRegistry.getCachedCommand.mockReturnValue({
                id: "cmd1",
                pluginId: "test-plugin",
                name: "Cmd 1",
                icon: "",
            });
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(true);

            // Mock executor functionality inside runner (relying on internal property access)
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean; executeCommand: (id: string, event: unknown) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(true);
            const executeSpy = vi.spyOn(executor, "executeCommand").mockReturnValue(true);
            const triggerEvent = { type: "keydown" };
            mockCtx.app.lastEvent = triggerEvent;
            vi.spyOn(runner, "ensurePluginLoaded").mockImplementation(async () => {
                // Input that arrives while the plugin loads must not replace the triggering event.
                mockCtx.app.lastEvent = { type: "mousemove" };
                return true;
            });

            await runner.runLazyCommand("cmd1");

            expect(executeSpy).toHaveBeenCalledWith("cmd1", triggerEvent);
        });

        it("should show notice when the real command never becomes available", async () => {
            mockRegistry.getCachedCommand.mockReturnValue({
                id: "cmd1",
                pluginId: "test-plugin",
                name: "Cmd 1",
                icon: "",
            });
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(true);
            vi.mocked(utilsMs.isPluginEnabled).mockReturnValue(true);
            vi.spyOn(runner, "waitForCommand").mockResolvedValue(false);

            await runner.runLazyCommand("cmd1");

            const notice = Notice as unknown as { messages: string[] };
            expect(notice.messages.length).toBe(1);
            expect(notice.messages[0]).toContain("cmd1");
            expect(notice.messages[0]).toContain("test-plugin");
        });

        it("should stop when the plugin cannot be loaded", async () => {
            mockRegistry.getCachedCommand.mockReturnValue({ id: "cmd1", pluginId: "test-plugin" });
            vi.spyOn(runner, "ensurePluginLoaded").mockResolvedValue(false);
            const executor = (runner as unknown as { commandExecutor: { executeCommand: (id: string, event: unknown) => boolean } }).commandExecutor;
            const executeSpy = vi.spyOn(executor, "executeCommand");

            await runner.runLazyCommand("cmd1");

            expect(executeSpy).not.toHaveBeenCalled();
            expect((Notice as unknown as { messages: string[] }).messages).toHaveLength(0);
        });

        it("should log and swallow command readiness errors when console logging is enabled", async () => {
            mockRegistry.getCachedCommand.mockReturnValue({ id: "cmd1", pluginId: "test-plugin" });
            mockCtx.getData.mockReturnValue({ showConsoleLog: true });
            vi.spyOn(runner, "ensurePluginLoaded").mockResolvedValue(true);
            vi.spyOn(runner, "waitForCommand").mockRejectedValue(new Error("readiness failed"));

            await expect(runner.runLazyCommand("cmd1")).resolves.toBeUndefined();
        });
    });

    describe("waitForCommand", () => {
        it("should return true immediately if command is executable", async () => {
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(true);

            const result = await runner.waitForCommand("cmd1");
            expect(result).toBe(true);
        });

        it("should wait for a view registration event", async () => {
            const viewRegistry = new EventEmitter();
            mockCtx.app.viewRegistry = viewRegistry;
            mockCtx.app.workspace = undefined;
            let executable = false;
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockImplementation(() => executable);

            const waiting = runner.waitForCommand("cmd1", 1000);
            executable = true;
            viewRegistry.emit("view-registered");

            await expect(waiting).resolves.toBe(true);
        });

        it("should wait for a workspace layout change", async () => {
            const workspace = new EventEmitter();
            mockCtx.app.workspace = workspace;
            let executable = false;
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockImplementation(() => executable);

            const waiting = runner.waitForCommand("cmd1", 1000);
            executable = true;
            workspace.emit("layout-change");

            await expect(waiting).resolves.toBe(true);
        });

        it("should return false after the readiness wait times out", async () => {
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(false);

            await expect(runner.waitForCommand("cmd1", 1)).resolves.toBe(false);
        });

        it("should return false when no readiness event source exists", async () => {
            mockCtx.app.workspace = undefined;
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(false);

            await expect(runner.waitForCommand("cmd1")).resolves.toBe(false);
        });

        it("should recheck readiness before subscribing to events", async () => {
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValueOnce(false).mockReturnValueOnce(true);

            await expect(runner.waitForCommand("cmd1")).resolves.toBe(true);
        });
    });
});
