/**
 * PluginContext — shared state interface that all services depend on.
 *
 * Instead of each service declaring its own `*Deps` interface with overlapping
 * callbacks, they all receive a single PluginContext that provides unified
 * access to the Obsidian runtime and Lazy Plugin settings.
 */
import type { Commands, Plugins } from "@obsidian-typings/obsidian-public-latest";
import type { App, EventRef, PluginManifest } from "obsidian";
import type { DeviceSettings, LazySettings, PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { layerProvidingPlugin } from "src/services/settings/settings-layers";

/** The per-plugin maps of a settings layer: the shared defaults or a profile's overrides. */
export type PluginLayer = Pick<DeviceSettings, "plugins" | "lazyOnViews" | "lazyOnFiles">;

/** Edits a copy of the saved settings; `profileId` is the active profile. */
export type SettingsChange = (data: LazySettings, profileId: string) => void | Promise<void>;

/**
 * Minimal view of Obsidian's `Commands` object used by services.
 */
// export interface ObsidianCommands {
//     commands: Record<string, unknown>;
//     addCommand: (command: {
//         id: string;
//         name: string;
//         icon?: string;
//         callback: () => Promise<void>;
//     }) => void;
//     removeCommand?: (id: string) => void;
// }

/**
 * Minimal view of Obsidian's `Plugins` object used by services.
 */
// export interface ObsidianPlugins {
//     manifests: Record<string, PluginManifest>;
//     enabledPlugins: Set<string>;
//     plugins?: PluginsMap;
//     enablePlugin: (id: string) => Promise<void>;
//     disablePlugin: (id: string) => Promise<void>;
//     loadingPluginId?: string;
// }

/**
 * The shared context that every service can depend on.
 *
 * This replaces the numerous `*Deps` interfaces that were
 * duplicating the same fields across services.
 */
export interface PluginContext {
    readonly app: App;
    readonly obsidianPlugins: Plugins;
    readonly obsidianCommands: Commands;
    readonly _plugin: OnDemandPlugin;

    /** Get all plugin manifests (excluding self and platform-filtered). */
    getManifests(): PluginManifest[];

    /** Resolve the PluginMode for a given plugin. */
    getPluginMode(pluginId: string): PLUGIN_MODE;

    /** Get the default mode for a plugin (based on community-plugins.json state). */
    getDefaultModeForPlugin(pluginId: string): PLUGIN_MODE;

    /** Derive a pluginId from a command id (e.g. "myplugin:do-thing" → "myplugin"). */
    getCommandPluginId(commandId: string): string | null;

    /** Access the global LazySettings data object. */
    getData(): LazySettings;

    /** The settings the active profile runs with. A fresh copy: edits go to a layer, not here. */
    getSettings(): DeviceSettings;

    /** The live layer that holds a plugin's settings for the active profile (see layerProvidingPlugin). */
    getPluginLayer(pluginId: string): PluginLayer;

    /** The live layer a user edit of a plugin goes to; the active profile then overrides that plugin. */
    getPluginLayerForEdit(pluginId: string): PluginLayer;

    /** Persist settings to disk. */
    saveSettings(): Promise<void>;

    /** Persist one change without the unsaved settings draft; use for saves the user did not review. */
    saveSettingsChange(change: SettingsChange): Promise<void>;

    /** Register event/unload handler (for monkey-patches). */
    register(unload: () => void): void;

    /** Register an event reference. */
    registerEvent(eventRef: EventRef): void;

    /** Whether the plugin is enabled on disk (community-plugins.json). */
    isPluginEnabledOnDisk(pluginId: string): boolean;
}

/**
 * Create a PluginContext adapter that bridges the Obsidian Plugin instance
 * to the PluginContext interface used by all services.
 */
export function createPluginContext(plugin: OnDemandPlugin): PluginContext {
    const appWithInternals = plugin.app as App & {
        plugins: Plugins;
        commands: Commands;
    };

    return {
        _plugin: plugin,
        get app() {
            return plugin.app;
        },
        get obsidianPlugins() {
            return appWithInternals.plugins;
        },
        get obsidianCommands() {
            return appWithInternals.commands;
        },
        getManifests: () => plugin.manifests,
        getPluginMode: (pluginId) => plugin.getPluginMode(pluginId),
        getDefaultModeForPlugin: (pluginId) => plugin.getDefaultModeForPlugin(pluginId),
        getCommandPluginId: (commandId) => {
            const [prefix] = commandId.split(":");
            return plugin.manifests.some((p) => p.id === prefix) ? prefix : null;
        },
        getData: () => plugin.data,
        getSettings: () => plugin.settings,
        getPluginLayerForEdit: (pluginId) => plugin.core.settingsService.pluginLayerForEdit(pluginId),
        getPluginLayer: (pluginId) => layerProvidingPlugin(plugin.core.settingsService.data, plugin.core.settingsService.currentProfileId, pluginId),
        saveSettings: () => plugin.saveSettings(),
        saveSettingsChange: (change) => plugin.saveSettingsChange(change),
        register: (unload) => plugin.register(unload),
        registerEvent: (eventRef) => plugin.registerEvent(eventRef),
        isPluginEnabledOnDisk: (pluginId) => plugin.isPluginEnabledOnDisk(pluginId),
    };
}
