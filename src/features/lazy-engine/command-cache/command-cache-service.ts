import log from "loglevel";
import type { PluginManifest } from "obsidian";
import pTimeout from "p-timeout";
import pWaitFor from "p-wait-for";
import type { CachedCommand, PluginLoader } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLazyMode, isPluginLoaded } from "src/core/utils";
import { CommandCacheStore } from "src/features/lazy-engine/command-cache/command-cache-store";
import { waitForPluginInitialization } from "src/patches/plugin-initialization";

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

    async refreshCommandsForPlugin(pluginId: string): Promise<boolean> {
        const commands = await this.getCommandsForPlugin(pluginId);
        // An empty snapshot is valid too, but a failed load must preserve the stale cache.
        if (!commands.length && !isPluginLoaded(this.ctx.app, pluginId)) return false;
        this.store.set(pluginId, commands);
        return true;
    }

    async getCommandsForPlugin(pluginId: string): Promise<CachedCommand[]> {
        // enablePlugin only loads the plugin and does not add it to enabledPlugins,
        // so the loaded flag is the reliable "already running" signal.
        if (!isPluginLoaded(this.ctx.app, pluginId)) {
            await this.ctx.obsidianPlugins.enablePlugin(pluginId);
        }

        await waitForPluginInitialization(this.ctx, pluginId);

        if (!this.isPluginReadyForCommandSnapshot(pluginId)) {
            await this.waitForPluginReadyForCommandSnapshot(pluginId);
        }

        const commands = Object.values(this.ctx.obsidianCommands.commands) as CachedCommand[];
        return commands
            .filter((cmd) => this.ctx.getCommandPluginId(cmd.id) === pluginId && !this.isWrapperCommand(cmd.id))
            .map((cmd) => ({
                id: cmd.id,
                name: cmd.name,
                icon: cmd.icon,
                pluginId,
            }));
    }

    async ensureCommandsCached(pluginId: string): Promise<void> {
        if (this.store.isValid(pluginId)) return;
        if (await this.refreshCommandsForPlugin(pluginId)) this.store.persist();
    }

    async forceReloadPluginCache(pluginId: string): Promise<void> {
        const cachedIds = this.store.getIds(pluginId);
        const hadWrappers = cachedIds ? Array.from(cachedIds).some((commandId) => this.isWrapperCommand(commandId)) : false;

        try {
            await this.snapshotCommandsForPlugin(pluginId);
            this.persistCache();
        } finally {
            // The snapshot removes wrappers first; restore them from the previous cache on failure.
            if (hadWrappers) {
                this.registerCachedCommandsForPlugin(pluginId);
            }
        }
    }

    /** Capture without serializing the entire cache; bulk rebuilds persist once at the end. */
    async snapshotCommandsForPlugin(pluginId: string): Promise<void> {
        this.removeCachedCommandsForPlugin(pluginId);
        if (!(await this.refreshCommandsForPlugin(pluginId))) throw new Error(`Failed to snapshot plugin ${pluginId}`);
    }

    persistCache(): void {
        this.store.persist();
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
            if (this.isStaleCache(plugin.id)) continue;
            this.registerCachedCommandsForPlugin(plugin.id);
        }
    }

    /** Lazy plugins whose cached commands were built for a different plugin version. */
    getStaleCachedPluginIds(): string[] {
        return this.getLazyManifests()
            .filter((p) => this.isStaleCache(p.id))
            .map((p) => p.id);
    }

    /**
     * Rebuild the command cache for a plugin whose cache is stale, then register
     * fresh wrappers. Snapshotting requires actually loading the plugin, so restore
     * the disabled state afterwards to keep lazy loading intact.
     *
     * When the plugin fails to load (e.g. flaky CI environment), the existing cache
     * is preserved but the version is NOT bumped so future startups retry the
     * refresh. Bumping the version on load failure would cause stale command IDs to
     * be registered as wrappers on the next startup (issue #6).
     */
    async refreshStaleCacheForPlugin(pluginId: string): Promise<void> {
        const wasLoaded = isPluginLoaded(this.ctx.app, pluginId);
        let changed: boolean;
        try {
            changed = await this.refreshCommandsForPlugin(pluginId);
            if (changed) {
                // Persist the version captured with this snapshot, preserving other stale versions.
                this.store.persist();
            }
            // If plugin did not load, do NOT bump the version. The stale cache
            // will trigger another refresh attempt on the next startup.
        } finally {
            if (!wasLoaded && isPluginLoaded(this.ctx.app, pluginId)) {
                await this.ctx.obsidianPlugins.disablePlugin(pluginId);
            }
        }
        // Only register wrappers after a successful snapshot (which may be empty).
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
        const wrapper = this.wrapperCommands.get(commandId);
        const existing = this.ctx.obsidianCommands.commands[commandId];

        if (wrapper && existing !== wrapper) {
            this.registeredWrappers.delete(commandId);
            this.wrapperCommands.delete(commandId);
            return;
        }

        if (wrapper && existing === wrapper) {
            this.ctx.obsidianCommands.removeCommand(commandId);
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
        // Same rule as registerCachedCommands: a cache built for another plugin version may
        // list removed command IDs, so never resurrect wrappers from it (issue #6). This also
        // runs from the enable/disable hooks while a stale cache is being refreshed.
        if (this.isStaleCache(pluginId)) return;

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

    private isStaleCache(pluginId: string): boolean {
        return this.store.has(pluginId) && !this.store.isValid(pluginId);
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
            return typeof commandId === "string" && this.ctx.getCommandPluginId(commandId) === pluginId && !this.isWrapperCommand(commandId);
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
