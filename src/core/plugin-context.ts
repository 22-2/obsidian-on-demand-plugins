/**
 * PluginContext — shared state interface that all services depend on.
 *
 * Instead of each service declaring its own `*Deps` interface with overlapping
 * callbacks, they all receive a single PluginContext that provides unified
 * access to the Obsidian runtime and Lazy Plugin settings.
 */
import type { Commands, Plugins } from "@obsidian-typings/obsidian-public-latest";
import type { App, Command, EventRef, PluginManifest } from "obsidian";
import type { DeviceSettings, LazySettings, PLUGIN_MODE } from "src/core/types";
import type OnDemandPlugin from "src/main";

/** Edits a copy of the saved settings; `profileId` is the active profile. */
export type SettingsChange = (data: LazySettings, profileId: string) => void | Promise<void>;

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
    /** This plugin's own manifest (id, version, dir). */
    readonly manifest: PluginManifest;

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

    /** Access the current device settings. */
    getSettings(): DeviceSettings;

    /** Persist settings to disk. */
    saveSettings(): Promise<void>;

    /** Persist one change without the unsaved settings draft; use for saves the user did not review. */
    saveSettingsChange(change: SettingsChange): Promise<void>;

    /** Register event/unload handler (for monkey-patches). */
    register(unload: () => void): void;

    /** Register an event reference. */
    registerEvent(eventRef: EventRef): void;

    /** Register a command owned by this plugin. */
    addCommand(command: Command): Command;

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
        get app() {
            return plugin.app;
        },
        get obsidianPlugins() {
            return appWithInternals.plugins;
        },
        get obsidianCommands() {
            return appWithInternals.commands;
        },
        get manifest() {
            return plugin.manifest;
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
        saveSettings: () => plugin.saveSettings(),
        saveSettingsChange: (change) => plugin.saveSettingsChange(change),
        register: (unload) => plugin.register(unload),
        registerEvent: (eventRef) => plugin.registerEvent(eventRef),
        addCommand: (command) => plugin.addCommand(command),
        isPluginEnabledOnDisk: (pluginId) => plugin.isPluginEnabledOnDisk(pluginId),
    };
}
