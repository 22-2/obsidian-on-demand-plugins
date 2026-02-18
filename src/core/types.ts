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
    plugins: { [pluginId: string]: PluginSettings };
    lazyOnViews: { [pluginId: string]: string[] };
    lazyOnFiles: { [pluginId: string]: FileActivationCriteria };
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
    // defaultMode: "disabled",
    showDescriptions: true,
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

export const PLUGIN_MODE = {
    ALWAYS_DISABLED: "alwaysDisabled",
    LAZY: "lazy",
    ALWAYS_ENABLED: "alwaysEnabled",
    LAZY_ON_VIEW: "lazyOnView",
    LAZY_ON_LAYOUT_READY: "lazyOnLayoutReady",
} as const;

export type PluginMode = typeof PLUGIN_MODE[keyof typeof PLUGIN_MODE];

export const PluginModes: Record<PluginMode, string> = {
    [PLUGIN_MODE.ALWAYS_DISABLED]: "⛔ Always disabled",
    [PLUGIN_MODE.LAZY]: "Lazy on demand",
    [PLUGIN_MODE.LAZY_ON_VIEW]: "Lazy on command/view (legacy)",
    [PLUGIN_MODE.LAZY_ON_LAYOUT_READY]: "Lazy on layout ready",
    [PLUGIN_MODE.ALWAYS_ENABLED]: "✅ Always enabled",
};
