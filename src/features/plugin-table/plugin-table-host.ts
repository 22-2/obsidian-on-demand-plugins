import type { App, PluginManifest } from "obsidian";
import type { PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";
import type { DraftSession } from "src/ui/drafts/draft-session";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";
import { stagePluginMode } from "src/ui/settings/helpers";

/**
 * Everything the plugin table may use from On-Demand. The table never reaches the
 * lazy engine or the patches directly, so changes there cannot break it, and it only
 * edits the shared settings draft, never the saved settings.
 */
export interface PluginTableHost {
    readonly app: App;
    readonly drafts: DraftSession;
    /** On-Demand itself: listed, but its mode cannot change, since it is what applies the modes. */
    readonly selfId: string;
    /** Reloads the installed manifests, since plugins can be installed while the table is open. Includes On-Demand itself. */
    getManifests(): PluginManifest[];
    getMode(pluginId: string): PLUGIN_MODE;
    /** Stages a mode change in the draft; false when it changes nothing. */
    stageMode(pluginId: string, mode: PLUGIN_MODE): boolean;
    /** Opens the lazy options for a plugin; `onSave` runs only when they changed. */
    openLazyOptions(pluginId: string, onSave: () => void): void;
}

export function createPluginTableHost(plugin: OnDemandPlugin, drafts: DraftSession): PluginTableHost {
    return {
        app: plugin.app,
        drafts,
        selfId: plugin.manifest.id,
        getManifests: () => {
            plugin.updateManifests();
            // The registry leaves On-Demand out because the lazy engine must never manage it; the table only lists it.
            return [...plugin.manifests, plugin.manifest];
        },
        getMode: (pluginId) => plugin.getPluginMode(pluginId),
        stageMode: (pluginId, mode) => stagePluginMode(plugin, pluginId, mode),
        openLazyOptions: (pluginId, onSave) => new LazyOptionsModal(plugin.app, plugin, pluginId, onSave).open(),
    };
}
