import { MarkdownView } from "obsidian";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import type { CommandRegistry } from "../../../core/interfaces";
import type { PluginContext } from "../../../core/plugin-context";
import { CommandExecutor } from "./command-executor";

describe("CommandExecutor", () => {
    let executor: CommandExecutor;
    let mockCtx: any;
    let mockRegistry: Mocked<CommandRegistry>;

    beforeEach(() => {
        vi.resetAllMocks();

        // Mock global activeDocument
        (global as any).activeDocument = {
            activeElement: {
                closest: vi.fn().mockReturnValue(null),
                contains: vi.fn().mockReturnValue(false),
            },
        };

        mockCtx = {
            app: {
                workspace: {
                    activeEditor: null,
                },
            },
            obsidianCommands: {
                commands: {},
            },
            getData: vi.fn().mockReturnValue({ showConsoleLog: false }),
        };

        mockRegistry = {
            isWrapperCommand: vi.fn().mockReturnValue(false),
            getCachedCommand: vi.fn(),
            syncCommandWrappersForPlugin: vi.fn(),
        } as any;

        executor = new CommandExecutor(mockCtx as unknown as PluginContext, mockRegistry);
    });

    describe("isCommandExecutable", () => {
        it("should return true if any callback exists", () => {
            mockCtx.obsidianCommands.commands["cmd1"] = { callback: () => {} };
            expect(executor.isCommandExecutable("cmd1")).toBe(true);
        });

        it("should return true if editorCallback exists", () => {
            mockCtx.obsidianCommands.commands["cmd1"] = { editorCallback: () => {} };
            expect(executor.isCommandExecutable("cmd1")).toBe(true);
        });

        it("should return false if it is a wrapper command", () => {
            mockCtx.obsidianCommands.commands["cmd1"] = { callback: () => {} };
            mockRegistry.isWrapperCommand.mockReturnValue(true);
            expect(executor.isCommandExecutable("cmd1")).toBe(false);
        });

        it("should return false if command does not exist", () => {
            expect(executor.isCommandExecutable("non-existent")).toBe(false);
        });
    });

    describe("executeCommandDirect", () => {
        it("should prefer editorCheckCallback when editor is active", () => {
            const spy = vi.fn();
            const cmd = {
                editorCheckCallback: vi.fn((checking: boolean) => {
                    if (!checking) spy();
                    return true;
                }),
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;
            mockCtx.app.workspace.activeEditor = { editor: {} };

            const result = executor.executeCommandDirect("cmd1");
            expect(result).toBe(true);
            expect(cmd.editorCheckCallback).toHaveBeenCalledWith(true, expect.anything(), expect.anything());
            expect(cmd.editorCheckCallback).toHaveBeenCalledWith(false, expect.anything(), expect.anything());
            expect(spy).toHaveBeenCalled();
        });

        it("should fallback to editorCallback", () => {
            const cmd = {
                editorCallback: vi.fn(),
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;
            mockCtx.app.workspace.activeEditor = { editor: {} };

            const result = executor.executeCommandDirect("cmd1");
            expect(result).toBe(true);
            expect(cmd.editorCallback).toHaveBeenCalled();
        });

        it("should use checkCallback when no editor or editor callbacks", () => {
            const spy = vi.fn();
            const cmd = {
                checkCallback: vi.fn((checking: boolean) => {
                    if (!checking) spy();
                    return true;
                }),
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;

            const result = executor.executeCommandDirect("cmd1");
            expect(result).toBe(true);
            expect(cmd.checkCallback).toHaveBeenCalledWith(true);
            expect(cmd.checkCallback).toHaveBeenCalledWith(false);
            expect(spy).toHaveBeenCalled();
        });

        it("should fallback to simple callback", () => {
            const cmd = {
                callback: vi.fn(),
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;

            const result = executor.executeCommandDirect("cmd1");
            expect(result).toBe(true);
            expect(cmd.callback).toHaveBeenCalled();
        });

        it("should return false if editorCheckCallback returns false", () => {
            const cmd = {
                editorCheckCallback: vi.fn(() => false),
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;
            mockCtx.app.workspace.activeEditor = { editor: {} };

            expect(executor.executeCommandDirect("cmd1")).toBe(false);
        });

        it("should return false if active element is title element", () => {
            // @ts-expect-error
            const view = new MarkdownView();
            (view as any).inlineTitleEl = { contains: vi.fn().mockReturnValue(true) };
            mockCtx.app.workspace.activeEditor = view;
            (view as any).editor = {};

            const cmd = { callback: vi.fn() };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;

            expect(executor.executeCommandDirect("cmd1")).toBe(false);
            expect(cmd.callback).not.toHaveBeenCalled();
        });

        it("should return false if in metadata-container and allowProperties is false", () => {
            mockCtx.app.workspace.activeEditor = { editor: {} };
            (activeDocument.activeElement?.closest as any).mockReturnValue({}); // in a container

            const cmd = {
                callback: vi.fn(),
                allowProperties: false,
            };
            mockCtx.obsidianCommands.commands["cmd1"] = cmd;

            expect(executor.executeCommandDirect("cmd1")).toBe(false);
            expect(cmd.callback).not.toHaveBeenCalled();
        });
    });
});
