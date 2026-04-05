import log from "loglevel";
import type { MarkdownFileInfo } from "obsidian";
import { MarkdownView } from "obsidian";
import type { CommandRegistry } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/CommandExecutor");

export class CommandExecutor {
    private ctx: PluginContext;
    private commandRegistry: CommandRegistry;

    constructor(ctx: PluginContext, commandRegistry: CommandRegistry) {
        this.ctx = ctx;
        this.commandRegistry = commandRegistry;
    }

    /**
     * Execute a command by invoking its registered callback function.
     * Attempts to call the most appropriate callback (editorCheckCallback, editorCallback, checkCallback, or callback) based on available context.
     * @param commandId - The command ID to execute
     * @returns True if the command was executed successfully, false otherwise
     */
    executeCommandDirect(commandId: string): boolean {
        const command = this.ctx.obsidianCommands.commands[commandId];

        if (!command) return false;

        const activeEditor: MarkdownFileInfo | null = this.ctx.app.workspace.activeEditor;

        if (activeEditor && activeEditor.editor) {
            const editor = activeEditor.editor;
            const activeElement = document.activeElement;

            // Follow conditions from obsidian's source
            if (activeEditor instanceof MarkdownView) {
                const view = activeEditor;
                if (view.inlineTitleEl?.contains(activeElement) || view.titleEl?.contains(activeElement)) {
                    return false;
                }
            }

            if (!command.allowProperties && activeElement?.closest(".metadata-container")) {
                return false;
            }

            if (!command.allowPreview && (activeEditor as MarkdownView).getMode?.() === "preview") {
                return false;
            }

            if (typeof command.editorCheckCallback === "function") {
                const editorCheckCallback = command.editorCheckCallback as unknown as (checking: boolean, editor: unknown, info: MarkdownFileInfo) => boolean;
                if (editorCheckCallback(true, editor, activeEditor)) {
                    if (this.ctx.getData().showConsoleLog) {
                        logger.debug(`Executing editorCheckCallback for: ${commandId}`);
                    }
                    editorCheckCallback(false, editor, activeEditor);
                    return true;
                }
                return false;
            }

            if (typeof command.editorCallback === "function") {
                const editorCallback = command.editorCallback as unknown as (editor: unknown, info: MarkdownFileInfo) => void;
                if (this.ctx.getData().showConsoleLog) {
                    logger.debug(`Executing editorCallback for: ${commandId}`);
                }
                editorCallback(editor, activeEditor);
                return true;
            }
        }

        if (typeof command.checkCallback === "function") {
            if (command.checkCallback(true)) {
                if (this.ctx.getData().showConsoleLog) {
                    logger.debug(`Executing checkCallback for: ${commandId}`);
                }
                command.checkCallback(false);
                return true;
            }
            return false;
        }

        if (typeof command.callback === "function") {
            if (this.ctx.getData().showConsoleLog) {
                logger.debug(`Executing callback for: ${commandId}`);
            }
            command.callback();
            return true;
        }

        return false;
    }

    isCommandExecutable(commandId: string): boolean {
        const command = this.ctx.obsidianCommands.commands[commandId];

        if (!command) return false;

        // Don't treat our own wrappers as "executable" while waiting for the real plugin to load.
        // This avoids recursive loops and false positives.
        if (this.commandRegistry.isWrapperCommand(commandId)) {
            return false;
        }

        return typeof command.callback === "function" || typeof command.checkCallback === "function" || typeof command.editorCallback === "function" || typeof command.editorCheckCallback === "function";
    }
}
