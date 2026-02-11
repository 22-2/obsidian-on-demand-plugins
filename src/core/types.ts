/**
 * Shared type definitions extracted from settings.ts
 * These types are used across multiple features/services.
 */

export interface PluginSettings {
    mode?: PluginMode;
    userConfigured?: boolean;
}

export interface FileActivationCriteria {
    extensions?: string[];
    frontmatterKeys?: string[];
    contentPatterns?: string[];
}

// Settings per device (desktop/mobile)
export interface DeviceSettings {
    // defaultMode: PluginMode;
    showDescriptions: boolean;
    reRegisterLazyCommandsOnDisable: boolean;
    plugins: { [pluginId: string]: PluginSettings };
    lazyOnViews: { [pluginId: string]: string[] };
    lazyOnFiles: { [pluginId: string]: FileActivationCriteria };
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
    // defaultMode: "disabled",
    showDescriptions: true,
    reRegisterLazyCommandsOnDisable: true,
    plugins: {},
    lazyOnViews: {},
    lazyOnFiles: {},
};

// Global settings for the plugin
export interface LazySettings {
    dualConfigs: boolean;
    showConsoleLog: boolean;
    desktop: DeviceSettings;
    mobile?: DeviceSettings;
    commandCache?: CommandCache;
    commandCacheVersions?: CommandCacheVersions;
    commandCacheUpdatedAt?: number;
}

export const DEFAULT_SETTINGS: LazySettings = {
    dualConfigs: false,
    showConsoleLog: false,
    desktop: DEFAULT_DEVICE_SETTINGS,
};

export interface CachedCommandEntry {
    id: string;
    name: string;
    icon?: string;
}

export type CommandCache = Record<string, CachedCommandEntry[]>;
export type CommandCacheVersions = Record<string, string>;

export type PluginMode = "disabled" | "lazy" | "keepEnabled" | "lazyOnView";

export const PluginModes: Record<PluginMode, string> = {
    disabled: "⛔ Always disabled",
    lazy: "Lazy on command",
    lazyOnView: "Lazy on command/view",
    keepEnabled: "✅ Always enabled",
};
