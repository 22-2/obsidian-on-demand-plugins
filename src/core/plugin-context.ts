/**
 * PluginContext — shared state interface that all services depend on.
 *
 * Instead of each service declaring its own `*Deps` interface with overlapping
 * callbacks, they all receive a single PluginContext that provides unified
 * access to the Obsidian runtime and Lazy Plugin settings.
 */
import type { App, PluginManifest } from "obsidian";
import type { Commands, Plugins } from "obsidian-typings";
import type OnDemandPlugin from "../main";
import type { DeviceSettings, LazySettings, PluginMode } from "./types";

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
    getPluginMode(pluginId: string): PluginMode;

    /** Get the default mode for a plugin (based on community-plugins.json state). */
    getDefaultModeForPlugin(pluginId: string): PluginMode;

    /** Derive a pluginId from a command id (e.g. "myplugin:do-thing" → "myplugin"). */
    getCommandPluginId(commandId: string): string | null;

    /** Access the global LazySettings data object. */
    getData(): LazySettings;

    /** Access the current device settings. */
    getSettings(): DeviceSettings;

    /** Persist settings to disk. */
    saveSettings(): Promise<void>;

    /** Register event/unload handler (for monkey-patches). */
    register(unload: () => void): void;

    /** Register an event reference. */
    registerEvent(eventRef: import("obsidian").EventRef): void;

    /** Whether the plugin is enabled on disk (community-plugins.json). */
    isPluginEnabledOnDisk(pluginId: string): boolean;
}

/**
 * Create a PluginContext adapter that bridges the Obsidian Plugin instance
 * to the PluginContext interface used by all services.
 */
export function createPluginContext(plugin: OnDemandPlugin): PluginContext {
    return {
        _plugin: plugin,
        get app() {
            return plugin.app;
        },
        get obsidianPlugins() {
            return (plugin.app as unknown as { plugins: Plugins }).plugins;
        },
        get obsidianCommands() {
            return (plugin.app as unknown as { commands: Commands }).commands;
        },
        getManifests: () => plugin.manifests,
        getPluginMode: (pluginId) => plugin.getPluginMode(pluginId),
        getDefaultModeForPlugin: (pluginId) => plugin.getDefaultModeForPlugin(pluginId),
        getCommandPluginId: (commandId) => plugin.getCommandPluginId(commandId),
        getData: () => plugin.data,
        getSettings: () => plugin.settings,
        saveSettings: () => plugin.saveSettings(),
        register: plugin.register.bind(plugin),
        registerEvent: plugin.registerEvent.bind(plugin),
        isPluginEnabledOnDisk: (pluginId) => plugin.isPluginEnabledOnDisk(pluginId),
    };
}
