import { Mutex } from "async-mutex";
import log from "loglevel";
import { Notice } from "obsidian";
import pWaitFor from "p-wait-for";
import type { CommandRegistry, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isPluginLoaded } from "src/core/utils";
import { CommandExecutor } from "src/features/lazy-engine/lazy-runner/command-executor";
import { getPluginDisplayName, PluginLoadNotice } from "src/ui/load-feedback";

const logger = log.getLogger("OnDemandPlugin/LazyCommandRunner");

interface ReadinessEventSource {
    on(name: string, callback: () => void): unknown;
    off(name: string, callback: () => void): unknown;
}

export class LazyCommandRunner implements PluginLoader {
    // Manage locks per pluginId
    private pluginMutexes = new Map<string, Mutex>();
    private readonly cancelCommandWaits = new Set<() => void>();
    private readonly commandExecutor: CommandExecutor;
    private readonly commandRegistry: CommandRegistry;
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private readonly ctx: PluginContext;

    constructor(ctx: PluginContext, commandRegistry: CommandRegistry) {
        this.ctx = ctx;
        this.commandRegistry = commandRegistry;
        this.commandExecutor = new CommandExecutor(ctx, commandRegistry);
    }

    clear() {
        for (const cancel of this.cancelCommandWaits) cancel();
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
        // Read before the first await: the wrapper is invoked synchronously from the palette or
        // a hotkey, so lastEvent is still the triggering event. Loading the plugin can take long
        // enough for later input to replace it.
        const triggerEvent = this.ctx.app.lastEvent;
        const cached = this.commandRegistry.getCachedCommand(commandId);
        if (!cached) {
            new Notice(`Command cache miss for "${commandId}". Please try rebuilding the cache from the Open tools button in settings.`);
            return;
        }

        // Loading a plugin can take seconds, and the command looks ignored until it runs.
        const loadNotice = isPluginLoaded(this.ctx.app, cached.pluginId) ? null : new PluginLoadNotice(getPluginDisplayName(this.ctx, cached.pluginId));
        const success = await this.ensurePluginLoaded(cached.pluginId);
        if (!success) {
            loadNotice?.fail();
            return;
        }
        loadNotice?.succeed();

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
                    this.commandExecutor.executeCommand(cached.id, triggerEvent);
                    resolve();
                });
            });
        } catch (error) {
            logger.error(`Error executing lazy command ${commandId}:`, error);
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
                // CLI loads can leave a live instance outside enabledPlugins;
                // runtime readiness must not depend on the saved enablement policy.
                if (loaded) {
                    this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
                    return true;
                }

                await this.ctx.obsidianPlugins.enablePlugin(pluginId);
                const loadSuccess = await this.waitForPluginLoaded(pluginId);

                if (!loadSuccess) return false;

                this.commandRegistry.syncCommandWrappersForPlugin(pluginId);
                return true;
            } catch (error) {
                logger.error(`Error loading plugin ${pluginId}:`, error);
                return false;
            }
        });
    }

    async waitForCommand(commandId: string, timeoutMs = 8000): Promise<boolean> {
        if (this.commandExecutor.isCommandExecutable(commandId)) return true;

        try {
            return await this.waitForCommandEvents(commandId, timeoutMs);
        } catch (error) {
            logger.warn(`Could not wait for command ${commandId} to become ready: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    private async waitForCommandEvents(commandId: string, timeoutMs: number): Promise<boolean> {
        const viewRegistry = (this.ctx.app as unknown as { viewRegistry?: ReadinessEventSource }).viewRegistry;
        const workspace = this.ctx.app.workspace as ReadinessEventSource | undefined;
        if (this.commandExecutor.isCommandExecutable(commandId)) return true;
        if (!viewRegistry && !workspace) throw new Error("No readiness events are available");

        return await new Promise<boolean>((resolve, reject) => {
            const cleanup = () => {
                window.clearTimeout(timer);
                viewRegistry?.off("view-registered", check);
                workspace?.off("layout-change", check);
                this.cancelCommandWaits.delete(cancel);
            };
            const finish = (ready: boolean) => { cleanup(); resolve(ready); };
            const cancel = () => finish(false);
            const check = () => {
                try {
                    if (this.commandExecutor.isCommandExecutable(commandId)) finish(true);
                } catch (error) {
                    cleanup();
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            };
            const timer = window.setTimeout(cancel, timeoutMs);
            this.cancelCommandWaits.add(cancel);
            try {
                viewRegistry?.on("view-registered", check);
                workspace?.on("layout-change", check);
                check();
            } catch (error) {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    async waitForPluginLoaded(pluginId: string, timeoutMs = 8000): Promise<boolean> {
        try {
            await pWaitFor(() => isPluginLoaded(this.ctx.app, pluginId), { interval: 100, timeout: timeoutMs });
            return true;
        } catch (error) {
            logger.error(`Timeout waiting for plugin ${pluginId} to load`, error);
            return false;
        }
    }
}
