import type { DeviceSettings, FileActivationCriteria, LazySettings, PluginSettings, Profile, ProfileSettings } from "src/core/types";
import { DEFAULT_DEVICE_SETTINGS } from "src/core/types";

/** The per-plugin maps that together make up one plugin's settings. */
const PLUGIN_MAPS = ["plugins", "lazyOnViews", "lazyOnFiles"] as const;

/** One plugin's settings across the per-plugin maps; it is inherited or overridden as a unit. */
export type PluginUnit = {
    plugin?: PluginSettings;
    lazyOnViews?: string[];
    lazyOnFiles?: FileActivationCriteria;
};

/** Plugin IDs a layer defines a unit for. */
export function pluginIdsIn(layer: Pick<DeviceSettings, (typeof PLUGIN_MAPS)[number]>): Set<string> {
    return new Set(PLUGIN_MAPS.flatMap((key) => Object.keys(layer[key] ?? {})));
}

/** Whether a profile overrides this plugin instead of inheriting it. */
export function overridesPlugin(profile: ProfileSettings, pluginId: string): boolean {
    return PLUGIN_MAPS.some((key) => Object.hasOwn(profile[key] ?? {}, pluginId));
}

/** The layer a profile's values fall back to: the shared defaults, or built-in defaults for a snapshot. */
export function baseLayerFor(profile: Profile, defaults: DeviceSettings): DeviceSettings {
    return profile.snapshot ? DEFAULT_DEVICE_SETTINGS : defaults;
}

export function readPluginUnit(layer: Pick<DeviceSettings, (typeof PLUGIN_MAPS)[number]>, pluginId: string): PluginUnit {
    return {
        plugin: layer.plugins?.[pluginId],
        lazyOnViews: layer.lazyOnViews?.[pluginId],
        lazyOnFiles: layer.lazyOnFiles?.[pluginId],
    };
}

/** The unit the active profile uses for a plugin: its own when it overrides it, otherwise the base layer's. */
export function resolvePluginUnit(profile: Profile, defaults: DeviceSettings, pluginId: string): PluginUnit {
    return overridesPlugin(profile.settings, pluginId) ? readPluginUnit(profile.settings, pluginId) : readPluginUnit(baseLayerFor(profile, defaults), pluginId);
}

/**
 * The settings a profile actually runs with. A fresh copy: callers may read it freely, but edits
 * must go to a layer, since changes to this object are not saved.
 */
export function resolveEffectiveSettings(profile: Profile, defaults: DeviceSettings): DeviceSettings {
    const base = baseLayerFor(profile, defaults);
    const own = profile.settings;
    const effective: DeviceSettings = {
        defaultMode: own.defaultMode ?? base.defaultMode,
        pruneUninstalledEntries: own.pruneUninstalledEntries ?? base.pruneUninstalledEntries,
        plugins: {},
        lazyOnViews: {},
        lazyOnFiles: {},
    };
    for (const pluginId of new Set([...pluginIdsIn(base), ...pluginIdsIn(own)])) {
        const unit = resolvePluginUnit(profile, defaults, pluginId);
        if (unit.plugin !== undefined) effective.plugins[pluginId] = unit.plugin;
        if (unit.lazyOnViews !== undefined) effective.lazyOnViews[pluginId] = unit.lazyOnViews;
        if (unit.lazyOnFiles !== undefined) effective.lazyOnFiles[pluginId] = unit.lazyOnFiles;
    }
    return structuredClone(effective);
}

/**
 * Makes a profile override a plugin, starting from the unit it inherits, so editing one part
 * (say its mode) keeps the inherited rest (its lazy options). A no-op when it already overrides it.
 */
export function overridePlugin(profile: Profile, defaults: DeviceSettings, pluginId: string): void {
    if (overridesPlugin(profile.settings, pluginId)) return;
    const unit = structuredClone(readPluginUnit(baseLayerFor(profile, defaults), pluginId));
    // An empty entry still marks the override, so the plugin stops following the base layer.
    profile.settings.plugins[pluginId] = unit.plugin ?? {};
    if (unit.lazyOnViews !== undefined) profile.settings.lazyOnViews[pluginId] = unit.lazyOnViews;
    if (unit.lazyOnFiles !== undefined) profile.settings.lazyOnFiles[pluginId] = unit.lazyOnFiles;
}

/** Drops a profile's override of a plugin so it inherits again. */
export function inheritPlugin(profile: ProfileSettings, pluginId: string): void {
    for (const key of PLUGIN_MAPS) delete profile[key][pluginId];
}

/** A profile-wide value as the profile runs with it. */
export function resolveDeviceValue<K extends "defaultMode" | "pruneUninstalledEntries">(profile: Profile, defaults: DeviceSettings, key: K): DeviceSettings[K] {
    return (profile.settings[key] ?? baseLayerFor(profile, defaults)[key]) as DeviceSettings[K];
}

/**
 * Where an edit of a plugin's settings for a profile goes: the profile, which then overrides
 * the plugin (starting from the inherited unit). Works on live data and on copies alike.
 */
export function pluginLayerToEdit(data: Pick<LazySettings, "defaults" | "profiles">, profileId: string, pluginId: string): ProfileSettings {
    const profile = data.profiles[profileId];
    overridePlugin(profile, data.defaults, pluginId);
    return profile.settings;
}

/**
 * The layer a profile currently takes a plugin's unit from, for facts recorded about the plugin
 * (such as captured view types) that should not turn an inherited plugin into an override.
 * A snapshot has no shared layer to write to, so it overrides the plugin instead.
 */
export function layerProvidingPlugin(data: Pick<LazySettings, "defaults" | "profiles">, profileId: string, pluginId: string): Pick<DeviceSettings, (typeof PLUGIN_MAPS)[number]> {
    const profile = data.profiles[profileId];
    if (overridesPlugin(profile.settings, pluginId)) return profile.settings;
    if (!profile.snapshot) return data.defaults;
    return pluginLayerToEdit(data, profileId, pluginId);
}
