import type { CachedCommand } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import type { CommandCache } from "src/core/types";

export class CommandCacheStore {
    readonly commandCache = new Map<string, CachedCommand>();
    readonly pluginCommandIndex = new Map<string, Set<string>>();

    constructor(private ctx: PluginContext) {}

    get(commandId: string): CachedCommand | undefined {
        return this.commandCache.get(commandId);
    }

    set(pluginId: string, commands: CachedCommand[]): void {
        const ids = new Set<string>();
        for (const command of commands) {
            this.commandCache.set(command.id, command);
            ids.add(command.id);
        }
        this.pluginCommandIndex.set(pluginId, ids);
    }

    getIds(pluginId: string): Set<string> | undefined {
        return this.pluginCommandIndex.get(pluginId);
    }

    has(pluginId: string): boolean {
        return this.pluginCommandIndex.has(pluginId);
    }

    loadFromData(): void {
        const commandCacheSource = loadLocalStorage<CommandCache>(this.ctx.app, "commandCache");
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

    async persist(): Promise<void> {
        const cache: CommandCache = {};
        const versions: Record<string, string> = {};

        this.ctx.getManifests().forEach((plugin) => {
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

        saveLocalStorage(this.ctx.app, "commandCache", cache);
        saveLocalStorage(this.ctx.app, "commandCacheVersions", versions);
    }

    isValid(pluginId: string): boolean {
        if (!this.pluginCommandIndex.has(pluginId)) return false;

        const cached = loadLocalStorage<CommandCache>(this.ctx.app, "commandCache")?.[pluginId];
        if (!Array.isArray(cached) || cached.length === 0) return false;

        const manifest = this.ctx.getManifests().find((p) => p.id === pluginId);
        if (!manifest) return false;

        const cachedVersion = loadLocalStorage<Record<string, string>>(this.ctx.app, "commandCacheVersions")?.[pluginId];
        if (!cachedVersion) return false;

        return cachedVersion === (manifest.version ?? "");
    }

    clear(): void {
        this.commandCache.clear();
        this.pluginCommandIndex.clear();
    }
}
