import type { CachedCommand } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import type { CommandCache } from "src/core/types";

export class CommandCacheStore {
    readonly commandCache = new Map<string, CachedCommand>();
    readonly pluginCommandIndex = new Map<string, Set<string>>();

    private ctx: PluginContext;

    constructor(ctx: PluginContext) {
        this.ctx = ctx;
    }

    get(commandId: string): CachedCommand | undefined {
        return this.commandCache.get(commandId);
    }

    set(pluginId: string, commands: CachedCommand[]): void {
        // Drop the previous snapshot first: a plugin update can remove or rename
        // command IDs, and leaving the old entries in commandCache would resurrect
        // stale wrappers through persist()/loadFromData() (issue #6).
        const previous = this.pluginCommandIndex.get(pluginId);
        previous?.forEach((id) => this.commandCache.delete(id));

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

    persist(): void {
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

    // Bumps the stored version for a single plugin without rewriting the command
    // snapshot. Used when a stale-cache refresh could not capture commands (e.g.
    // the target plugin failed to load in CI) so the cache is preserved and
    // future startups do not retry indefinitely.
    markVersionCurrent(pluginId: string): void {
        const manifest = this.ctx.getManifests().find((p) => p.id === pluginId);
        if (!manifest) return;

        const versions = loadLocalStorage<Record<string, string>>(this.ctx.app, "commandCacheVersions") ?? {};
        versions[pluginId] = manifest.version ?? "";
        saveLocalStorage(this.ctx.app, "commandCacheVersions", versions);
    }

    clear(): void {
        this.commandCache.clear();
        this.pluginCommandIndex.clear();
    }
}
