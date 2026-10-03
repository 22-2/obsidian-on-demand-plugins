import log from "loglevel";
import type { PluginManifest } from "obsidian";
import { Notice } from "obsidian";
import type { EventBus } from "src/core/event-bus";
import type { AppFeature } from "src/core/feature";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import { isPluginLoaded } from "src/core/utils";
import type { CoreContainer } from "src/services/core-container";
import { PluginPickerModal } from "src/ui/modals/plugin-picker-modal";

const logger = log.getLogger("OnDemandPlugin/ManualToggleFeature");

/**
 * Returns manifests filtered by their live loaded state, sorted by name.
 * Pure helper so the picker's enable/disable candidate logic stays testable
 * without an Obsidian runtime.
 */
export function getToggleTargets(manifests: PluginManifest[], isLoaded: (pluginId: string) => boolean, wantLoaded: boolean): PluginManifest[] {
    return manifests.filter((manifest) => isLoaded(manifest.id) === wantLoaded).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Manual per-plugin enable/disable commands.
 * Both operate strictly in-memory (enablePlugin/disablePlugin without save)
 * so a restart restores the policy-driven state; nothing here touches
 * community-plugins.json or the staged settings draft.
 */
export class ManualToggleFeature implements AppFeature {
    private ctx!: PluginContext;

    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus) {
        this.ctx = ctx;
        ctx._plugin.addCommand({
            id: "enable-plugin-in-memory",
            name: "Enable specific plugin (in memory only)",
            callback: () => this.openEnablePicker(),
        });
        ctx._plugin.addCommand({
            id: "disable-plugin-in-memory",
            name: "Disable specific plugin (in memory only)",
            callback: () => this.openDisablePicker(),
        });
    }

    onunload() {}

    private openEnablePicker() {
        const targets = getToggleTargets(this.ctx.getManifests(), (id) => isPluginLoaded(this.ctx.app, id), false);
        if (targets.length === 0) {
            new Notice("Every plugin is already loaded");
            return;
        }
        new PluginPickerModal(this.ctx.app, targets, "Select a plugin to enable", (manifest) => void this.enableChosen(manifest)).open();
    }

    private openDisablePicker() {
        const targets = getToggleTargets(this.ctx.getManifests(), (id) => isPluginLoaded(this.ctx.app, id), true);
        if (targets.length === 0) {
            new Notice("No loaded plugin to disable");
            return;
        }
        new PluginPickerModal(this.ctx.app, targets, "Select a plugin to disable", (manifest) => void this.disableChosen(manifest)).open();
    }

    private async enableChosen(manifest: PluginManifest) {
        try {
            await this.ctx.obsidianPlugins.enablePlugin(manifest.id);
            new Notice(`Enabled ${manifest.name} (in memory only, not saved)`);
        } catch (error) {
            logger.error(`Failed to enable plugin ${manifest.id}`, error);
            new Notice(`Failed to enable ${manifest.name}`);
        }
    }

    private async disableChosen(manifest: PluginManifest) {
        try {
            await this.ctx.obsidianPlugins.disablePlugin(manifest.id);
            new Notice(`Disabled ${manifest.name} (in memory only, not saved)`);
        } catch (error) {
            logger.error(`Failed to disable plugin ${manifest.id}`, error);
            new Notice(`Failed to disable ${manifest.name}`);
        }
    }
}
