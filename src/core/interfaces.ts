/**
 * Interfaces shared between the command cache and the plugin-loading layer.
 *
 * LazyCommandRunner receives the cache as a CommandRegistry in its constructor;
 * CommandCacheService only gets a runLazyCommand callback, so there is no cycle.
 */

export interface CachedCommand {
    id: string;
    name: string;
    icon?: string;
    pluginId: string;
}

/**
 * What LazyCommandRunner needs from the command cache layer.
 * Implemented by CommandCacheService.
 */
export interface CommandRegistry {
    getCachedCommand(commandId: string): CachedCommand | undefined;
    isWrapperCommand(commandId: string): boolean;
    syncCommandWrappersForPlugin(pluginId: string): void;
    removeCachedCommandsForPlugin(pluginId: string): void;
}

/**
 * What the lazy loaders need from the plugin-loading layer.
 * Implemented by LazyCommandRunner.
 */
export interface PluginLoader {
    waitForPluginLoaded(pluginId: string, timeoutMs?: number): Promise<boolean>;
    runLazyCommand(commandId: string): Promise<void>;
}
