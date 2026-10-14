import type { CommandRegistry } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { CommandExecutor } from "src/features/lazy-engine/lazy-runner/command-executor";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";

describe("CommandExecutor", () => {
    let executor: CommandExecutor;
    let commands: Record<string, unknown>;
    let mockCtx: {
        obsidianCommands: {
            findCommand: ReturnType<typeof vi.fn>;
            executeCommandById: ReturnType<typeof vi.fn>;
        };
        getData: ReturnType<typeof vi.fn>;
    };
    let mockRegistry: Mocked<CommandRegistry>;

    beforeEach(() => {
        vi.resetAllMocks();

        commands = {};
        mockCtx = {
            obsidianCommands: {
                findCommand: vi.fn((id: string) => commands[id]),
                executeCommandById: vi.fn().mockReturnValue(true),
            },
            getData: vi.fn().mockReturnValue({ showConsoleLog: false }),
        };

        mockRegistry = {
            isWrapperCommand: vi.fn().mockReturnValue(false),
            getCachedCommand: vi.fn(),
            syncCommandWrappersForPlugin: vi.fn(),
        } as unknown as Mocked<CommandRegistry>;

        executor = new CommandExecutor(mockCtx as unknown as PluginContext, mockRegistry);
    });

    describe("isCommandExecutable", () => {
        it("should return true for a callback command", () => {
            commands["cmd1"] = { callback: () => {} };
            expect(executor.isCommandExecutable("cmd1")).toBe(true);
        });

        it("should return true for a checkCallback command", () => {
            // Obsidian stores editor commands with a generated checkCallback.
            commands["cmd1"] = { checkCallback: () => true };
            expect(executor.isCommandExecutable("cmd1")).toBe(true);
        });

        it("should return false if it is a wrapper command", () => {
            commands["cmd1"] = { callback: () => {} };
            mockRegistry.isWrapperCommand.mockReturnValue(true);
            expect(executor.isCommandExecutable("cmd1")).toBe(false);
        });

        it("should return false if command does not exist", () => {
            expect(executor.isCommandExecutable("non-existent")).toBe(false);
        });
    });

    describe("executeCommand", () => {
        it("should run a callback command through Obsidian with the trigger event", () => {
            commands["cmd1"] = { callback: vi.fn() };
            const event = { type: "keydown" } as KeyboardEvent;

            expect(executor.executeCommand("cmd1", event)).toBe(true);
            expect(mockCtx.obsidianCommands.executeCommandById).toHaveBeenCalledWith("cmd1", event);
        });

        it("should pass no event when none was recorded", () => {
            commands["cmd1"] = { callback: vi.fn() };

            executor.executeCommand("cmd1", null);
            expect(mockCtx.obsidianCommands.executeCommandById).toHaveBeenCalledWith("cmd1", undefined);
        });

        it("should check checkCallback before running the command", () => {
            const checkCallback = vi.fn().mockReturnValue(true);
            commands["cmd1"] = { checkCallback };

            expect(executor.executeCommand("cmd1", null)).toBe(true);
            expect(checkCallback).toHaveBeenCalledWith(true);
            expect(mockCtx.obsidianCommands.executeCommandById).toHaveBeenCalledWith("cmd1", undefined);
        });

        it("should not run the command when checkCallback rejects the current context", () => {
            commands["cmd1"] = { checkCallback: vi.fn().mockReturnValue(false) };

            expect(executor.executeCommand("cmd1", null)).toBe(false);
            expect(mockCtx.obsidianCommands.executeCommandById).not.toHaveBeenCalled();
        });

        it("should return false if command does not exist", () => {
            expect(executor.executeCommand("non-existent", null)).toBe(false);
            expect(mockCtx.obsidianCommands.executeCommandById).not.toHaveBeenCalled();
        });
    });
});
