import { Mutex } from "async-mutex";
import log from "loglevel";
import type { Command, MarkdownFileInfo } from "obsidian";
import { MarkdownView } from "obsidian";
import type { ViewRegistry } from "obsidian-typings";
import { pEvent } from "p-event";
import pTimeout from "p-timeout";
import pWaitFor from "p-wait-for";
import type { CommandRegistry, PluginLoader } from "../../core/interfaces";
import type { PluginContext } from "../../core/plugin-context";
import { isPluginEnabled, isPluginLoaded } from "../../core/utils";

const logger = log.getLogger("OnDemandPlugin/LazyCommandRunner");

export class LazyCommandRunner implements PluginLoader {
    // Manage locks per pluginId
    private pluginMutexes = new Map<string, Mutex>();
    /** Injected after construction to break circular dependency. */
    private commandRegistry!: CommandRegistry;

    constructor(private ctx: PluginContext) {}

    /**
     * Setter injection — called by ServiceContainer after both services are created.
     */
    setCommandRegistry(registry: CommandRegistry) {
        this.commandRegistry = registry;
    }

    clear() {
        this.pluginMutexes.clear();
    }

    private getPluginMutex(pluginId: string): Mutex {
        let mutex = this.pluginMutexes.get(pluginId);
        if (!mutex) {
            mutex = new Mutex();
            this.pluginMutexes.set(pluginId, mutex);
        }
        return mutex;
    }

    async runLazyCommand(commandId: string) {
        const cached = this.commandRegistry.getCachedCommand(commandId);
        if (!cached) return;

        const success = await this.ensurePluginLoaded(cached.pluginId);
        if (!success) return;

        try {
            const ready = await this.waitForCommand(cached.id);
            if (!ready) return;

            if (this.ctx.getData().showConsoleLog) {
                logger.debug(`Executing lazy command: ${cached.id}`);
            }

            await new Promise<void>((resolve) => {
                queueMicrotask(() => {
                    this.executeCommandDirect(cached.id);
                    resolve();
                });
            });
        } catch (error) {
            if (this.ctx.getData().showConsoleLog) {
                logger.error(`Error executing lazy command ${commandId}:`, error);
            }
        }
    }

    async ensurePluginLoaded(pluginId: string): Promise<boolean> {
        const mutex = this.getPluginMutex(pluginId);

        return await mutex.runExclusive(async () => {
            try {
                const loaded = isPluginLoaded(this.ctx.app, pluginId);
                const enabled = isPluginEnabled(this.ctx.obsidianPlugins.enabledPlugins, pluginId);

                if (enabled && loaded) {
                    this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
                    return true;
                }

                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
                const loadSuccess = await this.waitForPluginLoaded(pluginId);

                if (!loadSuccess) return false;

                this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
                return true;
            } catch (error) {
                if (this.ctx.getData().showConsoleLog) {
                    logger.error(`Error loading plugin ${pluginId}:`, error);
                }
                return false;
            }
        });
    }

    async waitForCommand(commandId: string, timeoutMs = 8000): Promise<boolean> {
        if (this.isCommandExecutable(commandId)) return true;

        try {
            await pTimeout(this.createCommandReadyPromise(commandId), {
                milliseconds: timeoutMs,
            });
            return true;
        } catch (error) {
            logger.warn(`Timeout waiting for command ${commandId} to become ready ${error}`);
            return false;
        }
    }

    private async createCommandReadyPromise(commandId: string): Promise<void> {
        const viewRegistry = (this.ctx.app as unknown as { viewRegistry?: ViewRegistry }).viewRegistry;

        // Immediate check
        if (this.isCommandExecutable(commandId)) return;

        const promises: Promise<void>[] = [];

        // Wait for viewRegistry 'view-registered' event
        if (viewRegistry) {
            promises.push(
                pEvent(viewRegistry, "view-registered", {
                    filter: () => this.isCommandExecutable(commandId),
                    rejectionEvents: [],
                }) as Promise<void>,
            );
        }

        // Wait for workspace 'layout-change' event
        if (this.ctx.app.workspace) {
            promises.push(
                pEvent(this.ctx.app.workspace, "layout-change", {
                    filter: () => this.isCommandExecutable(commandId),
                    rejectionEvents: [],
                }) as Promise<void>,
            );
        }

        // Resolve when any event satisfies the condition
        if (promises.length > 0) {
            await Promise.race(promises);
        }
    }

    async waitForPluginLoaded(pluginId: string, timeoutMs = 8000): Promise<boolean> {
        try {
            await pTimeout(
                pWaitFor(() => isPluginLoaded(this.ctx.app, pluginId), {
                    interval: 100,
                }),
                {
                    milliseconds: timeoutMs,
                },
            );
            return true;
        } catch (error) {
            logger.error(`Timeout waiting for plugin ${pluginId} to load`, error);
            return false;
        }
    }

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

            // Follow conditions from myfiles/command.js
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
        if (this.commandRegistry?.isWrapperCommand(commandId)) {
            return false;
        }

        return typeof command.callback === "function" || typeof command.checkCallback === "function" || typeof command.editorCallback === "function" || typeof command.editorCheckCallback === "function";
    }
}
