import { Mutex } from "async-mutex";
import log from "loglevel";
import { Notice } from "obsidian";
import type { ViewRegistry } from "obsidian-typings";
import { pEvent } from "p-event";
import pTimeout from "p-timeout";
import pWaitFor from "p-wait-for";
import type { CommandRegistry, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isPluginEnabled, isPluginLoaded } from "src/core/utils";
import { CommandExecutor } from "src/features/lazy-engine/lazy-runner/command-executor";

const logger = log.getLogger("OnDemandPlugin/LazyCommandRunner");

export class LazyCommandRunner implements PluginLoader {
    // Manage locks per pluginId
    private pluginMutexes = new Map<string, Mutex>();
    private commandExecutor!: CommandExecutor;
    /** Injected after construction to break circular dependency. */
    private commandRegistry!: CommandRegistry;
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private ctx: PluginContext;

    constructor(ctx: PluginContext) {
        this.ctx = ctx;
    }

    /**
     * Setter injection — called by ServiceContainer after both services are created.
     */
    setCommandRegistry(registry: CommandRegistry) {
        this.commandRegistry = registry;
        this.commandExecutor = new CommandExecutor(this.ctx, registry);
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
            if (!ready) {
                this.showMissingCommandNotice(cached.id, cached.pluginId);
                return;
            }

            if (this.ctx.getData().showConsoleLog) {
                logger.debug(`Executing lazy command: ${cached.id}`);
            }

            await new Promise<void>((resolve) => {
                queueMicrotask(() => {
                    this.commandExecutor.executeCommandDirect(cached.id);
                    resolve();
                });
            });
        } catch (error) {
            if (this.ctx.getData().showConsoleLog) {
                logger.error(`Error executing lazy command ${commandId}:`, error);
            }
        }
    }

    private showMissingCommandNotice(commandId: string, pluginId: string): void {
        // Command metadata can be cached while the source plugin later disables the command,
        // so tell users why lazy execution could not find the real command implementation.
        new Notice(`Command not available: ${commandId} (plugin: ${pluginId}). It may be disabled in plugin settings.`);
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
        if (this.commandExecutor.isCommandExecutable(commandId)) return true;

        try {
            await pTimeout(this.createCommandReadyPromise(commandId), {
                milliseconds: timeoutMs,
            });
            return true;
        } catch (error) {
            logger.warn(`Timeout waiting for command ${commandId} to become ready ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    private async createCommandReadyPromise(commandId: string): Promise<void> {
        const viewRegistry = (this.ctx.app as unknown as { viewRegistry?: ViewRegistry }).viewRegistry;

        // Immediate check
        if (this.commandExecutor.isCommandExecutable(commandId)) return;

        const promises: Promise<void>[] = [];

        // Wait for viewRegistry 'view-registered' event
        if (viewRegistry) {
            promises.push(
                pEvent(viewRegistry, "view-registered", {
                    filter: () => this.commandExecutor.isCommandExecutable(commandId),
                    rejectionEvents: [],
                }) as Promise<void>,
            );
        }

        // Wait for workspace 'layout-change' event
        if (this.ctx.app.workspace) {
            promises.push(
                pEvent(this.ctx.app.workspace, "layout-change", {
                    filter: () => this.commandExecutor.isCommandExecutable(commandId),
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
}
