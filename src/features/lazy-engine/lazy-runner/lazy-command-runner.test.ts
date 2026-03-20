import pWaitFor from "p-wait-for";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRegistry } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import * as utilsMs from "src/core/utils";
import { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";

vi.mock("../../../core/utils", () => ({
    isPluginLoaded: vi.fn(),
    isPluginEnabled: vi.fn(),
}));
vi.mock("p-wait-for");

describe("LazyCommandRunner", () => {
    let runner: LazyCommandRunner;
    let mockCtx: {
        app: { workspace: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> } };
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

        mockCtx = {
            app: {
                workspace: {
                    on: vi.fn(),
                    off: vi.fn(),
                },
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

        it("should use mutex to serialize multiple calls for same plugin", async () => {
            vi.mocked(utilsMs.isPluginLoaded).mockReturnValue(false);
            vi.mocked(pWaitFor).mockResolvedValue(undefined);

            // First call will trigger enablePlugin.
            // Second call (serialized by mutex) should see it's already loaded and skip enablePlugin.
            mockCtx.obsidianPlugins.enablePlugin.mockReturnValue(
                new Promise<void>((resolve) =>
                    setTimeout(() => {
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
        it("should do nothing if command is not cached", async () => {
            mockRegistry.getCachedCommand.mockReturnValue(undefined);

            await runner.runLazyCommand("unknown");

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
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean; executeCommandDirect: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(true);
            const executeSpy = vi.spyOn(executor, "executeCommandDirect").mockReturnValue(true);

            await runner.runLazyCommand("cmd1");

            expect(executeSpy).toHaveBeenCalledWith("cmd1");
        });
    });

    describe("waitForCommand", () => {
        it("should return true immediately if command is executable", async () => {
            const executor = (runner as unknown as { commandExecutor: { isCommandExecutable: (id: string) => boolean } }).commandExecutor;
            vi.spyOn(executor, "isCommandExecutable").mockReturnValue(true);

            const result = await runner.waitForCommand("cmd1");
            expect(result).toBe(true);
        });
    });
});
