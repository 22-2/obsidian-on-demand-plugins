import type { AppFeature } from "src/core/feature";
import type { PluginContext } from "src/core/plugin-context";
import { PLUGIN_MODE } from "src/core/types";
import type { CoreContainer } from "src/services/core-container";
import type { PluginRegistry } from "src/services/registry/plugin-registry";
import type { FeatureManager } from "src/core/feature-manager";
import type { EventBus} from "src/core/event-bus";
import { FeatureEvents } from "src/core/event-bus";

export type SyncDirection = "coreToLazy" | "lazyToCore";

interface SyncPreviewResult {
    label: string;
    summary: string;
}

interface SyncResult {
    changed: number;
    message: string;
}

export class MaintenanceFeature implements AppFeature {
    private ctx!: PluginContext;
    private registry!: PluginRegistry;
    private events!: EventBus;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.ctx = ctx;
        this.registry = core.registry;
        this.events = events;
    }

    onunload() {}

    async rebuildAndApplyCommandCache(options?: { force?: boolean }) {
        await this.events.emit(FeatureEvents.REBUILD_CACHE_REQUESTED, options);
    }

    async buildSyncPreview(direction: SyncDirection): Promise<SyncPreviewResult> {
        await this.registry.loadEnabledPluginsFromDisk(this.ctx.getData().showConsoleLog);
        const onDisk = this.registry.enabledPluginsFromDisk;
        const manifests = this.ctx.getManifests();

        if (direction === "coreToLazy") {
            const toEnable = manifests.filter((m) => onDisk.has(m.id) && this.ctx.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_DISABLED);
            const toDisable = manifests.filter((m) => !onDisk.has(m.id) && this.ctx.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED);

            return {
                label: "📂 community-plugins.json ➔ ⚙️ On-Demand Plugins",
                summary: this.buildDiffSummary(
                    `Enabled on disk: ${onDisk.size} plugins`,
                    toEnable.map((m) => m.name),
                    toDisable.map((m) => m.name),
                ),
            };
        } else {
            const alwaysEnabled = this.getAlwaysEnabledIds();
            const toAdd = alwaysEnabled.filter((id) => !onDisk.has(id));
            const toRemove = Array.from(onDisk).filter((id) => !alwaysEnabled.includes(id) && manifests.some((m) => m.id === id));

            return {
                label: "⚙️ On-Demand Plugins ➔ 📂 community-plugins.json",
                summary: this.buildDiffSummary(`Always Enabled in On-Demand: ${alwaysEnabled.length} plugins`, toAdd, toRemove),
            };
        }
    }

    async executeSync(direction: SyncDirection): Promise<SyncResult> {
        await this.registry.loadEnabledPluginsFromDisk(this.ctx.getData().showConsoleLog);

        if (direction === "coreToLazy") {
            return this.syncCoreToLazy();
        } else {
            return this.syncLazyToCore();
        }
    }

    private syncCoreToLazy(): SyncResult {
        const onDisk = this.registry.enabledPluginsFromDisk;
        let changed = 0;
        const manifests = this.ctx.getManifests();
        const settings = this.ctx.getSettings();

        for (const manifest of manifests) {
            const isOnDisk = onDisk.has(manifest.id);
            const currentMode = this.ctx.getPluginMode(manifest.id);

            const targetMode: PLUGIN_MODE | null = isOnDisk && currentMode === PLUGIN_MODE.ALWAYS_DISABLED ? PLUGIN_MODE.ALWAYS_ENABLED : !isOnDisk && currentMode === PLUGIN_MODE.ALWAYS_ENABLED ? PLUGIN_MODE.ALWAYS_DISABLED : null;

            if (targetMode) {
                settings.plugins[manifest.id] = {
                    mode: targetMode,
                    userConfigured: true,
                };
                changed++;
            }
        }

        if (changed > 0) {
            return { changed, message: `Staged ${changed} plugin changes from Obsidian config. Click "Save" to apply.` };
        }
        return { changed: 0, message: "On-Demand Plugins is already in sync with Obsidian config" };
    }

    private async syncLazyToCore(): Promise<SyncResult> {
        const alwaysEnabled = this.getAlwaysEnabledIds();
        const currentOnDisk = Array.from(this.registry.enabledPluginsFromDisk);
        const isSame = alwaysEnabled.length === currentOnDisk.length && alwaysEnabled.every((id) => currentOnDisk.includes(id));

        if (!isSame) {
            await this.registry.writeCommunityPluginsFile(alwaysEnabled, this.ctx.getData().showConsoleLog);
            await this.registry.loadEnabledPluginsFromDisk(this.ctx.getData().showConsoleLog);
            return {
                changed: 1,
                message: "Updated community-plugins.json based on Plugin data",
            };
        }
        return {
            changed: 0,
            message: "Obsidian config is already in sync with Plugin data",
        };
    }

    applyBatchModeReplace(fromMode: PLUGIN_MODE, toMode: PLUGIN_MODE): number {
        let changed = 0;
        const manifests = this.ctx.getManifests();
        const settings = this.ctx.getSettings();

        for (const manifest of manifests) {
            if (this.ctx.getPluginMode(manifest.id) === fromMode) {
                settings.plugins[manifest.id] = {
                    mode: toMode,
                    userConfigured: true,
                };
                changed++;
            }
        }
        return changed;
    }

    private getAlwaysEnabledIds(): string[] {
        const ids = this.ctx
            .getManifests()
            .filter((m) => this.ctx.getPluginMode(m.id) === PLUGIN_MODE.ALWAYS_ENABLED)
            .map((m) => m.id);

        const selfId = this.ctx._plugin.manifest.id;
        if (!ids.includes(selfId)) {
            ids.push(selfId);
        }
        return ids;
    }

    private buildDiffSummary(header: string, toAdd: string[], toRemove: string[]): string {
        const preview = (items: string[]) => `${items.slice(0, 3).join(", ")}${items.length > 3 ? "..." : ""}`;

        let summary = `${header}\n`;
        if (toAdd.length > 0) summary += `➕ Will enable: ${toAdd.length} (${preview(toAdd)})\n`;
        if (toRemove.length > 0) summary += `➖ Will disable: ${toRemove.length} (${preview(toRemove)})\n`;
        if (toAdd.length === 0 && toRemove.length === 0) summary += "✅ Already in sync";

        return summary;
    }
}
