import { PluginManifest } from "obsidian";
import { CommandCache, LazySettings, PluginMode } from "../settings";

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
        plugins?: Record<string, { _loaded?: boolean }>;
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
}

export class CommandCacheService {
    private commandCache = new Map<string, CachedCommand>();
    private pluginCommandIndex = new Map<string, Set<string>>();
    private registeredWrappers = new Set<string>();

    constructor(private deps: CommandCacheDeps) {}

    getCachedCommand(commandId: string) {
        return this.commandCache.get(commandId);
    }

    loadFromData() {
        const data = this.deps.getData();
        if (!data.commandCache) return;

        this.commandCache.clear();
        this.pluginCommandIndex.clear();

        Object.entries(data.commandCache).forEach(([pluginId, commands]) => {
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

    async refreshCommandCache() {
        let updated = false;
        for (const plugin of this.deps.getManifests()) {
            const mode = this.deps.getPluginMode(plugin.id);
            if (mode === "lazy") {
                if (this.isCommandCacheValid(plugin.id)) continue;
                updated =
                    (await this.refreshCommandsForPlugin(plugin.id)) || updated;
            }
        }

        if (updated) {
            await this.persistCommandCache();
        }
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

        if (!this.deps.obsidianPlugins.plugins?.[pluginId]?._loaded) {
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

        if (
            !wasEnabled &&
            this.deps.getPluginMode(pluginId) !== "keepEnabled"
        ) {
            await this.deps.obsidianPlugins.disablePlugin(pluginId);
        }

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
            if (this.deps.getPluginMode(plugin.id) === "lazy") {
                this.registerCachedCommandsForPlugin(plugin.id);
            }
        }
    }

    registerCachedCommandsForPlugin(pluginId: string) {
        const commandIds = this.pluginCommandIndex.get(pluginId);
        if (!commandIds) return;

        commandIds.forEach((commandId) => {
            if (this.registeredWrappers.has(commandId)) return;
            if (this.deps.obsidianCommands.commands[commandId]) return;

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
        if (typeof commands.removeCommand === "function") {
            commands.removeCommand(commandId);
        } else if (commands.commands && commands.commands[commandId]) {
            delete commands.commands[commandId];
        }
        this.registeredWrappers.delete(commandId);
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
