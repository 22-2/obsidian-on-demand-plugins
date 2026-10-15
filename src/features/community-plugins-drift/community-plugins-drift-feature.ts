import log from "loglevel";
import { Notice } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { ON_DEMAND_PLUGIN_ID } from "src/core/constants";
import type { EventBus } from "src/core/event-bus";
import type { AppFeature } from "src/core/feature";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import type { CommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import { computeDesiredCommunityPlugins, describeDrift, detectCommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import type { CoreContainer } from "src/services/core-container";
import type { PluginRegistry } from "src/services/registry/plugin-registry";

const logger = log.getLogger("OnDemandPlugin/CommunityPluginsDriftFeature");

const STARTUP_NOTICE_MS = 15_000;

/**
 * Detects edits to community-plugins.json made outside On-Demand without
 * patching anything: the file is compared at startup and before On-Demand
 * rewrites it. Nothing is changed automatically; the user decides whether to
 * sync the edits into the settings or let the next apply overwrite them.
 */
export class CommunityPluginsDriftFeature implements AppFeature {
    private ctx!: PluginContext;
    private registry!: PluginRegistry;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.ctx = ctx;
        this.registry = core.registry;
        // Reason: there is no record of what the previous session wrote, so the saved settings define the expected file.
        this.registry.knownOnDisk = new Set(this.getDesired());
        // Also runs when restricted mode is turned off, which loads this plugin again after the layout is ready.
        ctx.app.workspace.onLayoutReady(() => void this.notifyIfDrifted());
    }

    onunload() {}

    getDesired(): string[] {
        const ids = this.ctx.getManifests().map((manifest) => manifest.id);
        return computeDesiredCommunityPlugins(ids, (id) => this.ctx.getPluginMode(id), ON_DEMAND_PLUGIN_ID, this.registry.enabledPluginsFromDisk);
    }

    /** Re-reads the file and reports the entries the next write would undo. */
    async detect(): Promise<CommunityPluginsDrift | null> {
        await this.registry.loadEnabledPluginsFromDisk(this.ctx.getData().showConsoleLog);
        return detectCommunityPluginsDrift({
            onDisk: this.registry.enabledPluginsFromDisk,
            desired: new Set(this.getDesired()),
            known: this.registry.knownOnDisk,
            installed: this.ctx.getManifests().map((manifest) => manifest.id),
            selfId: ON_DEMAND_PLUGIN_ID,
        });
    }

    describe(drift: CommunityPluginsDrift): string {
        return describeDrift(drift, (id) => this.ctx.getManifests().find((manifest) => manifest.id === id)?.name ?? id);
    }

    async notifyIfDrifted(): Promise<CommunityPluginsDrift | null> {
        try {
            const drift = await this.detect();
            if (drift) {
                new Notice(`${this.describe(drift)} Use On-Demand Plugins › Maintenance › Sync settings to keep these changes; the next apply overwrites them.`, STARTUP_NOTICE_MS);
            }
            return drift;
        } catch (error) {
            logger.warn("Failed to check community-plugins.json for external changes", error);
            return null;
        }
    }

    /** Resolves true when there is nothing to lose or the user agrees to overwrite the external edits. */
    async confirmOverwrite(): Promise<boolean> {
        const drift = await this.detect();
        if (!drift) return true;
        const message = `${this.describe(drift)} Continuing overwrites these changes with the On-Demand settings. Continue?`;
        return (await showConfirmModal(this.ctx.app, { message })) === true;
    }
}
