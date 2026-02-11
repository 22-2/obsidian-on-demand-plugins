/**
 * Shared type definitions extracted from settings.ts
 * These types are used across multiple features/services.
 */

export interface LazyOptions {
    useView: boolean;
    viewTypes: string[];
    useFile: boolean;
    fileCriteria: FileActivationCriteria;
}

export interface PluginSettings {
    mode?: PluginMode;
    userConfigured?: boolean;
    lazyOptions?: LazyOptions;
}

export interface FileActivationCriteria {
    suffixes?: string[];
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

export type PluginMode = "disabled" | "lazy" | "keepEnabled" | "lazyOnView" | "lazyOnLayoutReady";

export const PluginModes: Record<PluginMode, string> = {
    disabled: "⛔ Always disabled",
    lazy: "Lazy on demand",
    lazyOnView: "Lazy on command/view (legacy)",
    lazyOnLayoutReady: "Lazy on layout ready",
    keepEnabled: "✅ Always enabled",
};
