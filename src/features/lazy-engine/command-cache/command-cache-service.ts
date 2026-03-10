import type { PluginManifest } from "obsidian";
import type { CachedCommand, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLazyMode, isPluginLoaded } from "src/core/utils";
import { CommandCacheStore } from "src/features/lazy-engine/command-cache/command-cache-store";

// Re-export for consumers
export type { CachedCommand } from "../../../core/interfaces";

export class CommandCacheService {
    private store: CommandCacheStore;
    private registeredWrappers = new Set<string>();
    private wrapperCommands = new Map<string, unknown>();

    constructor(
        private ctx: PluginContext,
        private pluginLoader: PluginLoader,
    ) {
        this.store = new CommandCacheStore(ctx);
    }

    // ---------------------------------------------------------------------------
    // Cache read (proxy to store)
    // ---------------------------------------------------------------------------

    getCachedCommand(commandId: string): CachedCommand | undefined {
        return this.store.get(commandId);
    }

    loadFromData(): void {
        this.store.loadFromData();
    }

    isCommandCacheValid(pluginId: string): boolean {
        return this.store.isValid(pluginId);
    }

    // ---------------------------------------------------------------------------
    // Cache refresh
    // ---------------------------------------------------------------------------

    async refreshCommandCache(pluginIds?: string[], force = false, onProgress?: (current: number, total: number, plugin: PluginManifest) => void): Promise<void> {
        let lazyManifests = this.getLazyManifests();
        if (pluginIds?.length) {
            lazyManifests = lazyManifests.filter((p) => pluginIds.includes(p.id));
        }

        const pluginsToRefresh = force ? lazyManifests : lazyManifests.filter((p) => !this.store.isValid(p.id));

        let hasChanges = false;
        for (const plugin of pluginsToRefresh) {
            const current = lazyManifests.indexOf(plugin) + 1;
            const changed = await this.refreshCommandsForPlugin(plugin.id);
            onProgress?.(current, lazyManifests.length, plugin);
            if (changed) hasChanges = true;
        }

        if (hasChanges) {
            await this.store.persist();
        }
    }

    async refreshCommandsForPlugin(pluginId: string): Promise<boolean> {
        const commands = await this.getCommandsForPlugin(pluginId);
        if (!commands.length) return false;
        this.store.set(pluginId, commands);
        return true;
    }

    async getCommandsForPlugin(pluginId: string): Promise<CachedCommand[]> {
        const wasEnabled = this.ctx.obsidianPlugins.enabledPlugins.has(pluginId);
        if (!wasEnabled) {
            await this.ctx.obsidianPlugins.enablePlugin(pluginId);
        }

        if (!isPluginLoaded(this.ctx.app, pluginId)) {
            await this.pluginLoader.waitForPluginLoaded(pluginId);
        }

        const commands = Object.values(this.ctx.obsidianCommands.commands) as CachedCommand[];
        return commands
            .filter((cmd) => this.ctx.getCommandPluginId(cmd.id) === pluginId)
            .map((cmd) => ({
                id: cmd.id,
                name: cmd.name,
                icon: cmd.icon,
                pluginId,
            }));
    }

    async ensureCommandsCached(pluginId: string): Promise<void> {
        if (this.store.isValid(pluginId)) return;
        await this.refreshCommandsForPlugin(pluginId);
        await this.store.persist();
    }

    // ---------------------------------------------------------------------------
    // Wrapper registration
    // ---------------------------------------------------------------------------

    registerCachedCommands(): void {
        for (const plugin of this.ctx.getManifests()) {
            if (this.isLazyMode(plugin.id)) {
                this.registerCachedCommandsForPlugin(plugin.id);
            }
        }
    }

    registerCachedCommandsForPlugin(pluginId: string): void {
        const commandIds = this.store.getIds(pluginId);
        if (!commandIds) return;

        commandIds.forEach((commandId) => {
            const existing = this.ctx.obsidianCommands.commands[commandId];
            const wrapper = this.wrapperCommands.get(commandId);

            if (existing && wrapper && existing !== wrapper) {
                this.registeredWrappers.delete(commandId);
                this.wrapperCommands.delete(commandId);
                return;
            }
            if (existing && wrapper && existing === wrapper) return;
            if (existing && !wrapper) return;

            const cached = this.store.get(commandId);
            if (!cached) return;

            const cmd = {
                id: commandId,
                name: cached.name,
                icon: cached.icon,
                callback: async () => {
                    await this.pluginLoader.runLazyCommand(commandId);
                },
            };

            this.ctx.obsidianCommands.addCommand(cmd);
            this.registeredWrappers.add(commandId);
            this.wrapperCommands.set(commandId, cmd);
        });
    }

    removeCachedCommandsForPlugin(pluginId: string): void {
        const commandIds = this.store.getIds(pluginId);
        if (!commandIds) return;
        commandIds.forEach((commandId) => this.removeCommandWrapper(commandId));
    }

    removeCommandWrapper(commandId: string): void {
        const commands = this.ctx.obsidianCommands as unknown as {
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
            } else if (commands.commands?.[commandId]) {
                delete commands.commands[commandId];
            }
        }

        this.registeredWrappers.delete(commandId);
        this.wrapperCommands.delete(commandId);
    }

    isWrapperCommand(commandId: string): boolean {
        const wrapper = this.wrapperCommands.get(commandId);
        if (!wrapper) return false;
        const existing = this.ctx.obsidianCommands.commands[commandId];
        return existing === wrapper;
    }

    syncCommandWrappersForPlugin(pluginId: string): void {
        const commandIds = this.store.getIds(pluginId);
        if (!commandIds) return;

        let shouldRegister = false;
        commandIds.forEach((commandId) => {
            const existing = this.ctx.obsidianCommands.commands[commandId];
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

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    clear(): void {
        this.registeredWrappers.forEach((commandId) => this.removeCommandWrapper(commandId));
        this.registeredWrappers.clear();
        this.store.clear();
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private getLazyManifests(): PluginManifest[] {
        return this.ctx.getManifests().filter((p) => this.isLazyMode(p.id));
    }

    private isLazyMode(pluginId: string): boolean {
        const mode = this.ctx.getPluginMode(pluginId);
        return isLazyMode(mode);
    }
}
