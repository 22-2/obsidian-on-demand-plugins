import log from "loglevel";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";
import type { CommandCacheService } from "src/features/lazy-engine/command-cache/command-cache-service";
import type { LazyCommandRunner } from "src/features/lazy-engine/lazy-runner/lazy-command-runner";

const logger = log.getLogger("OnDemandPlugin/LazyEngineFeature");

/** Loads layout-ready plugins before refreshing stale command caches. */
export class LayoutReadyLoader {
    private active = true;
    private readonly ctx: PluginContext;
    private readonly runner: LazyCommandRunner;
    private readonly cache: CommandCacheService;

    constructor(ctx: PluginContext, runner: LazyCommandRunner, cache: CommandCacheService) {
        this.ctx = ctx;
        this.runner = runner;
        this.cache = cache;
    }

    start(): void {
        this.ctx.app.workspace.onLayoutReady(() => {
            if (this.active) void this.run();
        });
    }

    stop(): void {
        this.active = false;
    }

    async run(): Promise<void> {
        if (!this.active) return;
        const toLoad = this.ctx.getManifests().filter((manifest) => this.ctx.getPluginMode(manifest.id) === PLUGIN_MODE.LAZY_ON_LAYOUT_READY);

        if (toLoad.length > 0) {
            await this.runTasks(toLoad.map((manifest) => manifest.id), async (id) => {
                await this.runner.ensurePluginLoaded(id).catch((error) => logger.error("Failed loading plugin onLayoutReady", id, error));
            });
            if (!this.active) return;
            this.cache.registerCachedCommands();
        }

        // Rebuild after layout-ready plugins load so the refresh sees their final state.
        if (!this.active) return;
        const staleIds = this.cache.getStaleCachedPluginIds();
        await this.runTasks(staleIds, async (id) => {
            await this.cache.refreshStaleCacheForPlugin(id).catch((error) => logger.error("Failed refreshing stale command cache", id, error));
        });
    }

    /** Stop taking new work after unload; already running plugin loads finish normally. */
    private async runTasks(ids: readonly string[], task: (id: string) => Promise<void>): Promise<void> {
        let next = 0;
        const worker = async () => {
            while (this.active && next < ids.length) await task(ids[next++]);
        };
        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    }
}
