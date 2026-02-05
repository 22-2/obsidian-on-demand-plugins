import { PluginManifest, App } from "obsidian";
import { loadJSON, saveJSON } from "./storage";
import { CommandCache, LazySettings, PluginMode } from "../settings";
import { isPluginLoaded, PluginsMap } from "../utils/utils";

export interface CachedCommand {
    id: string;
    name: string;
    icon?: string;
    pluginId: string;
}

interface CommandCacheDeps {
    obsidianCommands: {
        commands: Record<string, unknown>;
        addCommand: (command: {
            id: string;
            name: string;
            icon?: string;
            callback: () => Promise<void>;
        }) => void;
    };
    obsidianPlugins: {
        enabledPlugins: Set<string>;
        plugins?: PluginsMap;
        enablePlugin: (id: string) => Promise<void>;
        disablePlugin: (id: string) => Promise<void>;
    };
    getManifests: () => PluginManifest[];
    getPluginMode: (pluginId: string) => PluginMode;
    getCommandPluginId: (commandId: string) => string | null;
    waitForPluginLoaded: (
        pluginId: string,
        timeoutMs?: number,
    ) => Promise<boolean>;
    runLazyCommand: (commandId: string) => Promise<void>;
    getData: () => LazySettings;
    saveSettings: () => Promise<void>;
    app: App;
}

export class CommandCacheService {
    private commandCache = new Map<string, CachedCommand>();
    private pluginCommandIndex = new Map<string, Set<string>>();
    private registeredWrappers = new Set<string>();
    /** Tracks the actual command objects we register as wrappers, to distinguish them from real plugin commands. */
    private wrapperCommands = new Map<string, unknown>();

    constructor(private deps: CommandCacheDeps) {}

    getCachedCommand(commandId: string) {
        return this.commandCache.get(commandId);
    }

    loadFromData() {
        const data = this.deps.getData();
        // Prefer persisted settings data, but fall back to local store2 cache
        let commandCacheSource = data.commandCache;
        if (!commandCacheSource) {
            const stored = loadJSON<CommandCache>(this.deps.app, "commandCache");
            if (stored) {
                commandCacheSource = stored;
                // If we fell back to local cache, try to hydrate versions too
                const storedVersions = loadJSON<Record<string, string>>(this.deps.app, "commandCacheVersions");
                if (storedVersions && !data.commandCacheVersions) {
                    data.commandCacheVersions = storedVersions;
                }
            }
        }
        if (!commandCacheSource) return;

        this.commandCache.clear();
        this.pluginCommandIndex.clear();
        Object.entries(commandCacheSource).forEach(([pluginId, commands]) => {
            const ids = new Set<string>();
            commands.forEach((command) => {
                const cached: CachedCommand = {
                    id: command.id,
                    name: command.name,
                    icon: command.icon,
                    pluginId,
                };
                this.commandCache.set(cached.id, cached);
                ids.add(cached.id);
            });
            this.pluginCommandIndex.set(pluginId, ids);
        });
    }

    /**
     * Refresh command cache for specified lazy plugins or all if force is true.
     * @param pluginIds - Optional list of plugin IDs to refresh; if omitted, refreshes all
     * @param force - Force refresh even if cache is valid
     * @param onProgress - Optional callback for progress updates
     */
    async refreshCommandCache(
        pluginIds?: string[],
        force = false,
        onProgress?: (
            current: number,
            total: number,
            plugin: PluginManifest,
        ) => void,
    ) {
        let lazyManifests = this.getLazyManifests();
        if (pluginIds?.length) {
            lazyManifests = lazyManifests.filter((plugin) =>
                pluginIds.includes(plugin.id),
            );
        }

        const pluginsToRefresh = force
            ? lazyManifests
            : lazyManifests.filter(
                  (plugin) => !this.isCommandCacheValid(plugin.id),
              );

        const total = lazyManifests.length;
        let hasChanges = false;

        for (const plugin of pluginsToRefresh) {
            const current = lazyManifests.indexOf(plugin) + 1;
            const result = await this.refreshCommandsForPlugin(plugin.id);
            onProgress?.(current, total, plugin);
            if (result) hasChanges = true;
        }

        if (hasChanges) {
            await this.persistCommandCache();
        }
    }

    /**
     * Return only manifests whose mode is `lazy` or `lazyOnView`.
     */
    private getLazyManifests() {
        return this.deps
            .getManifests()
            .filter((plugin) => this.isLazyMode(plugin.id));
    }

    private isLazyMode(pluginId: string) {
        const mode = this.deps.getPluginMode(pluginId);
        return mode === "lazy" || mode === "lazyOnView";
    }

    async refreshCommandsForPlugin(pluginId: string): Promise<boolean> {
        const commands = await this.getCommandsForPlugin(pluginId);
        if (!commands.length) return false;

        const ids = new Set<string>();
        commands.forEach((command) => {
            this.commandCache.set(command.id, command);
            ids.add(command.id);
        });

        this.pluginCommandIndex.set(pluginId, ids);
        return true;
    }

    async getCommandsForPlugin(pluginId: string): Promise<CachedCommand[]> {
        const wasEnabled =
            this.deps.obsidianPlugins.enabledPlugins.has(pluginId);
        if (!wasEnabled) {
            await this.deps.obsidianPlugins.enablePlugin(pluginId);
        }

        if (!isPluginLoaded(this.deps.obsidianPlugins.plugins, pluginId)) {
            await this.deps.waitForPluginLoaded(pluginId);
        }

        const commands = Object.values(
            this.deps.obsidianCommands.commands,
        ) as CachedCommand[];
        const pluginCommands = commands
            .filter(
                (command) =>
                    this.deps.getCommandPluginId(command.id) === pluginId,
            )
            .map((command) => ({
                id: command.id,
                name: command.name,
                icon: command.icon,
                pluginId,
            }));

        // Do not disable here. We want to keep plugins enabled during cache rebuild
        // and rely on startup policy (community-plugins.json + reload) to apply
        // lazy states afterward.

        return pluginCommands;
    }

    ensureCommandsCached(pluginId: string) {
        return this.isCommandCacheValid(pluginId)
            ? Promise.resolve()
            : this.refreshCommandsForPlugin(pluginId).then(() =>
                  this.persistCommandCache(),
              );
    }

    registerCachedCommands() {
        for (const plugin of this.deps.getManifests()) {
            const mode = this.deps.getPluginMode(plugin.id);
            if (mode === "lazy" || mode === "lazyOnView") {
                this.registerCachedCommandsForPlugin(plugin.id);
            }
        }
    }

    registerCachedCommandsForPlugin(pluginId: string) {
        const commandIds = this.pluginCommandIndex.get(pluginId);
        if (!commandIds) return;

        commandIds.forEach((commandId) => {
            const existing = this.deps.obsidianCommands.commands[commandId];
            const wrapper = this.wrapperCommands.get(commandId);

            if (existing && wrapper && existing !== wrapper) {
                this.registeredWrappers.delete(commandId);
                this.wrapperCommands.delete(commandId);
                return;
            }

            if (existing && wrapper && existing === wrapper) return;
            if (existing && !wrapper) return;

            const cached = this.commandCache.get(commandId);
            if (!cached) return;

            const cmd = {
                id: commandId,
                name: cached.name,
                icon: cached.icon,
                callback: async () => {
                    await this.deps.runLazyCommand(commandId);
                },
            };

            this.deps.obsidianCommands.addCommand(cmd);
            this.registeredWrappers.add(commandId);
            this.wrapperCommands.set(commandId, cmd);
        });
    }

    removeCachedCommandsForPlugin(pluginId: string) {
        const commandIds = this.pluginCommandIndex.get(pluginId);
        if (!commandIds) return;

        commandIds.forEach((commandId) => this.removeCommandWrapper(commandId));
    }

    removeCommandWrapper(commandId: string) {
        const commands = this.deps.obsidianCommands as unknown as {
            removeCommand?: (id: string) => void;
            commands?: Record<string, unknown>;
        };
        const wrapper = this.wrapperCommands.get(commandId);
        const existing = commands.commands?.[commandId];

        if (wrapper && existing !== wrapper) {
            this.registeredWrappers.delete(commandId);
            this.wrapperCommands.delete(commandId);
            return;
        }

        if (wrapper && existing === wrapper) {
            if (typeof commands.removeCommand === "function") {
                commands.removeCommand(commandId);
            } else if (commands.commands && commands.commands[commandId]) {
                delete commands.commands[commandId];
            }
        }
        this.registeredWrappers.delete(commandId);
        this.wrapperCommands.delete(commandId);
    }

    isWrapperCommand(commandId: string): boolean {
        const wrapper = this.wrapperCommands.get(commandId);
        if (!wrapper) return false;
        const existing = this.deps.obsidianCommands.commands[commandId];
        return existing === wrapper;
    }

    /**
     * Ensures consistent command state by swapping wrappers for real commands where available,
     * or restoring wrappers if real commands are missing. This avoids "command gaps" during loading.
     */
    syncCommandWrappersForPlugin(pluginId: string) {
        const commandIds = this.pluginCommandIndex.get(pluginId);
        if (!commandIds) return;

        let shouldRegister = false;
        commandIds.forEach((commandId) => {
            const existing = this.deps.obsidianCommands.commands[commandId];
            const wrapper = this.wrapperCommands.get(commandId);

            if (existing && wrapper && existing !== wrapper) {
                this.registeredWrappers.delete(commandId);
                this.wrapperCommands.delete(commandId);
                return;
            }

            if (!existing) {
                shouldRegister = true;
            }
        });

        if (shouldRegister) {
            this.registerCachedCommandsForPlugin(pluginId);
        }
    }

    isCommandCacheValid(pluginId: string): boolean {
        if (!this.pluginCommandIndex.has(pluginId)) return false;
        const cached = this.deps.getData().commandCache?.[pluginId];
        if (!Array.isArray(cached) || cached.length === 0) return false;

        const manifest = this.deps
            .getManifests()
            .find((plugin) => plugin.id === pluginId);
        if (!manifest) return false;

        const cachedVersion =
            this.deps.getData().commandCacheVersions?.[pluginId];
        if (!cachedVersion) return false;

        return cachedVersion === (manifest.version ?? "");
    }

    async persistCommandCache() {
        const cache: CommandCache = {};
        const versions: Record<string, string> = {};
        this.deps.getManifests().forEach((plugin) => {
            const commands = Array.from(this.commandCache.values())
                .filter((command) => command.pluginId === plugin.id)
                .map((command) => ({
                    id: command.id,
                    name: command.name,
                    icon: command.icon,
                }));
            if (commands.length) {
                cache[plugin.id] = commands;
                versions[plugin.id] = plugin.version ?? "";
            }
        });

        const data = this.deps.getData();
        data.commandCache = cache;
        data.commandCacheVersions = versions;
        data.commandCacheUpdatedAt = Date.now();
        await this.deps.saveSettings();

        // Also persist local copies keyed by vault (appId) for faster/local retrieval
        saveJSON(this.deps.app, "commandCache", cache);
        saveJSON(this.deps.app, "commandCacheVersions", versions);
    }

    clear() {
        this.registeredWrappers.forEach((commandId) =>
            this.removeCommandWrapper(commandId),
        );
        this.registeredWrappers.clear();
        this.commandCache.clear();
        this.pluginCommandIndex.clear();
    }
}
