import { Command, Editor, MarkdownView } from "obsidian";
import log from "loglevel";
import { Mutex } from "async-mutex";
import pWaitFor from "p-wait-for";
import { pEvent } from "p-event";
import pTimeout from "p-timeout";
import { ViewRegistry } from "obsidian-typings";
import { PluginContext } from "../../core/plugin-context";
import { CommandRegistry, PluginLoader } from "../../core/interfaces";
import { isPluginLoaded, isPluginEnabled } from "../../utils/utils";

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
                logger.error(
                    `Error executing lazy command ${commandId}:`,
                    error,
                );
            }
        }
    }

    async ensurePluginLoaded(pluginId: string): Promise<boolean> {
        const mutex = this.getPluginMutex(pluginId);

        return await mutex.runExclusive(async () => {
            try {
                const loaded = isPluginLoaded(
                    this.ctx.app,
                    pluginId,
                );
                const enabled = isPluginEnabled(
                    this.ctx.obsidianPlugins.enabledPlugins,
                    pluginId,
                );

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

    async waitForCommand(
        commandId: string,
        timeoutMs = 8000,
    ): Promise<boolean> {
        if (this.isCommandExecutable(commandId)) return true;

        try {
            await pTimeout(
                this.createCommandReadyPromise(commandId),
                {
                    milliseconds: timeoutMs,
                }
            );
            return true;
        } catch (error) {
            // Timeout or other error
            return false;
        }
    }

    private async createCommandReadyPromise(commandId: string): Promise<void> {
        const viewRegistry = (
            this.ctx.app as unknown as { viewRegistry?: ViewRegistry }
        ).viewRegistry;

        // Immediate check
        if (this.isCommandExecutable(commandId)) return;

        const promises: Promise<void>[] = [];

        // Wait for viewRegistry 'view-registered' event
        if (viewRegistry) {
            promises.push(
                pEvent(viewRegistry, "view-registered", {
                    filter: () => this.isCommandExecutable(commandId),
                    rejectionEvents: [],
                }) as Promise<void>
            );
        }

        // Wait for workspace 'layout-change' event
        if (this.ctx.app.workspace) {
            promises.push(
                pEvent(this.ctx.app.workspace, "layout-change", {
                    filter: () => this.isCommandExecutable(commandId),
                    rejectionEvents: [],
                }) as Promise<void>
            );
        }

        // Resolve when any event satisfies the condition
        if (promises.length > 0) {
            await Promise.race(promises);
        }
    }

    async waitForPluginLoaded(
        pluginId: string,
        timeoutMs = 8000,
    ): Promise<boolean> {
        try {
            await pTimeout(
                pWaitFor(
                    () => isPluginLoaded(this.ctx.app, pluginId),
                    {
                        interval: 100,
                    }
                ),
                {
                    milliseconds: timeoutMs,
                }
            );
            return true;
        } catch (error) {
            // Timeout
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
        const command = this.ctx.obsidianCommands.commands[commandId] as
            | {
                  callback?: () => void;
                  checkCallback?: (checking: boolean) => boolean | void;
                  editorCallback?: (editor: Editor, ctx?: unknown) => void;
                  editorCheckCallback?: (
                      checking: boolean,
                      editor: Editor,
                      ctx?: unknown,
                  ) => boolean | void;
              }
            | undefined;

        if (!command) return false;

        const view = this.ctx.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        const file = view?.file;

        if (editor && typeof command.editorCheckCallback === "function") {
            const ok = command.editorCheckCallback(true, editor, file);
            if (ok === false) return false;
            command.editorCheckCallback(false, editor, file);
            return true;
        }

        if (editor && typeof command.editorCallback === "function") {
            command.editorCallback(editor, file);
            return true;
        }

        if (typeof command.checkCallback === "function") {
            const ok = command.checkCallback(true);
            if (ok === false) return false;
            command.checkCallback(false);
            return true;
        }

        if (typeof command.callback === "function") {
            command.callback();
            return true;
        }

        return false;
    }

    isCommandExecutable(commandId: string): boolean {
        const command = this.ctx.obsidianCommands.commands[commandId] as Command
            | undefined;

        if (!command) return false;

        // Don't treat our own wrappers as "executable" while waiting for the real plugin to load.
        // This avoids recursive loops and false positives.
        if (this.commandRegistry?.isWrapperCommand(commandId)) {
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
