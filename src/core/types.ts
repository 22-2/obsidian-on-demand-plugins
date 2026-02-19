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

// Settings per profile
export interface Profile {
    id: string;
    name: string;
    settings: DeviceSettings;
}

// Global settings for the plugin
export interface LazySettings {
    showConsoleLog: boolean;

    // Profile Management
    profiles: Record<string, Profile>;
    desktopProfileId: string;
    mobileProfileId: string;

    // Command Cache (Global)
    commandCache?: CommandCache;
    commandCacheVersions?: CommandCacheVersions;
    commandCacheUpdatedAt?: number;

    // Legacy fields for migration (optional)
    dualConfigs?: boolean;
    desktop?: DeviceSettings;
    mobile?: DeviceSettings;
}

export const DEFAULT_PROFILE_ID = "Default";

export const DEFAULT_SETTINGS: LazySettings = {
    showConsoleLog: false,
    profiles: {
        [DEFAULT_PROFILE_ID]: {
            id: DEFAULT_PROFILE_ID,
            name: "Default",
            settings: DEFAULT_DEVICE_SETTINGS,
        },
    },
    desktopProfileId: DEFAULT_PROFILE_ID,
    mobileProfileId: DEFAULT_PROFILE_ID,
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
    /**
     * @deprecated
     */
    LAZY_ON_VIEW: "lazyOnView",
    LAZY_ON_LAYOUT_READY: "lazyOnLayoutReady",
} as const;

export type PluginMode = (typeof PLUGIN_MODE)[keyof typeof PLUGIN_MODE];

export const PluginModes: Record<PluginMode, string> = {
    [PLUGIN_MODE.ALWAYS_DISABLED]: "⛔ Always disabled",
    [PLUGIN_MODE.LAZY]: "Lazy on demand",
    [PLUGIN_MODE.LAZY_ON_VIEW]: "Lazy on command/view (legacy)",
    [PLUGIN_MODE.LAZY_ON_LAYOUT_READY]: "Lazy on layout ready",
    [PLUGIN_MODE.ALWAYS_ENABLED]: "✅ Always enabled",
};
