import type { PluginManifest } from "obsidian";
import type { CachedCommand, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLazyMode, isPluginLoaded } from "src/core/utils";
import { CommandCacheStore } from "src/features/lazy-engine/command-cache/command-cache-store";
import pTimeout from "p-timeout";
import pWaitFor from "p-wait-for";
import log from "loglevel";

const logger = log.getLogger("OnDemandPlugin/CommandCacheService");

// Re-export for consumers
export class CommandCacheService {
    private store: CommandCacheStore;
    private registeredWrappers = new Set<string>();
    private wrapperCommands = new Map<string, unknown>();

    private ctx: PluginContext;
    private pluginLoader: PluginLoader;

    constructor(ctx: PluginContext, pluginLoader: PluginLoader) {
        this.ctx = ctx;
        this.pluginLoader = pluginLoader;
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
            this.store.persist();
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

        if (!this.isPluginReadyForCommandSnapshot(pluginId)) {
            await this.waitForPluginReadyForCommandSnapshot(pluginId);
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
        this.store.persist();
    }

    async forceReloadPluginCache(pluginId: string): Promise<void> {
        const cachedIds = this.store.getIds(pluginId);
        const hadWrappers = cachedIds ? Array.from(cachedIds).some((commandId) => this.isWrapperCommand(commandId)) : false;

        // Keep the command palette clean: if wrappers were active, remove them before rebuilding.
        this.removeCachedCommandsForPlugin(pluginId);

        await this.refreshCommandsForPlugin(pluginId);
        this.store.persist();

        if (hadWrappers) {
            this.registerCachedCommandsForPlugin(pluginId);
        }
    }

    // ---------------------------------------------------------------------------
    // Wrapper registration
    // ---------------------------------------------------------------------------

    registerCachedCommands(): void {
        for (const plugin of this.ctx.getManifests()) {
            if (!this.isLazyMode(plugin.id)) continue;
            // A cache built for a different plugin version may contain command IDs that
            // no longer exist; registering those wrappers makes the first invocation fail
            // silently (issue #6). Skip them here — the startup flow refreshes stale
            // caches in the background after layout ready and registers fresh wrappers.
            if (this.store.has(plugin.id) && !this.store.isValid(plugin.id)) continue;
            this.registerCachedCommandsForPlugin(plugin.id);
        }
    }

    /** Lazy plugins whose cached commands were built for a different plugin version. */
    getStaleCachedPluginIds(): string[] {
        return this.getLazyManifests()
            .filter((p) => this.store.has(p.id) && !this.store.isValid(p.id))
            .map((p) => p.id);
    }

    /**
     * Rebuild the command cache for a plugin whose cache is stale, then register
     * fresh wrappers. Snapshotting requires actually loading the plugin, so restore
     * the disabled state afterwards to keep lazy loading intact.
     *
     * When the plugin fails to load (e.g. CI environment), the existing cache is
     * preserved and its version is bumped so future startups do not retry
     * indefinitely against a broken environment.
     */
    async refreshStaleCacheForPlugin(pluginId: string): Promise<void> {
        const wasEnabled = this.ctx.obsidianPlugins.enabledPlugins.has(pluginId);
        let changed = false;
        try {
            changed = await this.refreshCommandsForPlugin(pluginId);
            if (changed) {
                // persist() also rewrites commandCacheVersions from the current manifests,
                // which is what marks this cache valid again for future startups.
                this.store.persist();
            } else {
                // No commands captured (plugin likely failed to load). Preserve the
                // existing cache entries and bump the version so this stale cache
                // does not trigger infinite retries on subsequent startups.
                this.store.markVersionCurrent(pluginId);
            }
        } finally {
            if (!wasEnabled && isPluginLoaded(this.ctx.app, pluginId)) {
                await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            }
        }
        // Only register wrappers when the refresh actually captured fresh commands.
        // Registering from a stale cache (changed=false) would resurrect command IDs
        // that no longer exist in the current plugin version (issue #6).
        if (changed) {
            this.registerCachedCommandsForPlugin(pluginId);
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
                callback: () => {
                    void this.pluginLoader.runLazyCommand(commandId);
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

    private isPluginReadyForCommandSnapshot(pluginId: string): boolean {
        if (isPluginLoaded(this.ctx.app, pluginId)) {
            return true;
        }

        // Some plugins finish registering commands slightly before Obsidian flips its internal
        // loaded flag, so command discovery should proceed as soon as the target commands exist.
        return Object.values(this.ctx.obsidianCommands.commands).some((command) => {
            const commandId = (command as { id?: unknown }).id;
            return typeof commandId === "string" && this.ctx.getCommandPluginId(commandId) === pluginId;
        });
    }

    private async waitForPluginReadyForCommandSnapshot(pluginId: string, timeoutMs = 8000): Promise<void> {
        try {
            await pTimeout(
                pWaitFor(() => this.isPluginReadyForCommandSnapshot(pluginId), {
                    interval: 100,
                }),
                {
                    milliseconds: timeoutMs,
                },
            );
        } catch {
            // Keep the cache refresh moving even if Obsidian never flips the loaded flag.
            // The subsequent command snapshot will still capture whatever registered successfully.
            logger.warn(`Timeout waiting for plugin ${pluginId} to be ready for command snapshot`);
        }
    }
}
