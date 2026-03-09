import log from "loglevel";
import type { Command, MarkdownFileInfo } from "obsidian";
import { MarkdownView } from "obsidian";
import type { CommandRegistry } from "../../core/interfaces";
import type { PluginContext } from "../../core/plugin-context";

const logger = log.getLogger("OnDemandPlugin/CommandExecutor");

export class CommandExecutor {
    constructor(
        private ctx: PluginContext,
        private commandRegistry: CommandRegistry,
    ) {}

    /**
     * Execute a command by invoking its registered callback function.
     * Attempts to call the most appropriate callback (editorCheckCallback, editorCallback, checkCallback, or callback) based on available context.
     * @param commandId - The command ID to execute
     * @returns True if the command was executed successfully, false otherwise
     */
    executeCommandDirect(commandId: string): boolean {
        const command = this.ctx.obsidianCommands.commands[commandId] as Command;

        if (!command) return false;

        const activeEditor = this.ctx.app.workspace.activeEditor as MarkdownFileInfo | null;

        if (activeEditor && activeEditor.editor) {
            const editor = activeEditor.editor;

            // Follow conditions from obsidian's source
            if (activeEditor instanceof MarkdownView) {
                const view = activeEditor;
                const activeEl = activeDocument.activeElement;
                if (view.inlineTitleEl?.contains(activeEl) || view.titleEl?.contains(activeEl)) {
                    return false;
                }
            }

            if (!command.allowProperties && activeDocument.activeElement?.closest(".metadata-container")) {
                return false;
            }

            if (!command.allowPreview && (activeEditor as MarkdownView).getMode?.() === "preview") {
                return false;
            }

            if (typeof command.editorCheckCallback === "function") {
                if (command.editorCheckCallback(true, editor, activeEditor)) {
                    if (this.ctx.getData().showConsoleLog) {
                        logger.debug(`Executing editorCheckCallback for: ${commandId}`);
                    }
                    command.editorCheckCallback(false, editor, activeEditor);
                    return true;
                }
                return false;
            }

            if (typeof command.editorCallback === "function") {
                if (this.ctx.getData().showConsoleLog) {
                    logger.debug(`Executing editorCallback for: ${commandId}`);
                }
                command.editorCallback(editor, activeEditor);
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
        const command = this.ctx.obsidianCommands.commands[commandId] as Command | undefined;

        if (!command) return false;

        // Don't treat our own wrappers as "executable" while waiting for the real plugin to load.
        // This avoids recursive loops and false positives.
        if (this.commandRegistry.isWrapperCommand(commandId)) {
            return false;
        }

        return (
            typeof command.callback === "function" ||
            typeof command.checkCallback === "function" ||
            typeof command.editorCallback === "function" ||
            typeof command.editorCheckCallback === "function"
        );
    }
}
