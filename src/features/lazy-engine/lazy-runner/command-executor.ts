import log from "loglevel";
import type { UserEvent } from "obsidian";
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
     * Execute a command through Obsidian's own command runner.
     *
     * Obsidian folds `editorCallback` / `editorCheckCallback`, including its editor-state
     * guards (title focus, properties, preview mode), into `checkCallback` when a command
     * is added, so the real command already carries every condition Obsidian applies.
     * @param event - The user event that triggered the lazy wrapper, so commands can read modifier keys from `app.lastEvent`.
     * @returns True if the command was executed, false if it is missing or not available in the current context
     */
    executeCommand(commandId: string, event: UserEvent | null): boolean {
        const commands = this.ctx.obsidianCommands;
        const command = commands.findCommand(commandId);
        if (!command) return false;

        // The palette lists a command only when checkCallback(true) passes. The cached wrapper
        // is a plain callback that skipped that check, so apply it before running the real command.
        if (command.checkCallback && !command.checkCallback(true)) return false;

        if (this.ctx.getData().showConsoleLog) {
            logger.debug(`Executing command: ${commandId}`);
        }
        return commands.executeCommandById(commandId, event ?? undefined);
    }

    isCommandExecutable(commandId: string): boolean {
        const command = this.ctx.obsidianCommands.findCommand(commandId);

        if (!command) return false;

        // Don't treat our own wrappers as "executable" while waiting for the real plugin to load.
        // This avoids recursive loops and false positives.
        if (this.commandRegistry.isWrapperCommand(commandId)) {
            return false;
        }

        return typeof command.callback === "function" || typeof command.checkCallback === "function";
    }
}
