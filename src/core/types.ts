/**
 * Shared type definitions extracted from settings.ts
 * These types are used across multiple features/services.
 */

export const PLUGIN_MODE = {
    ALWAYS_DISABLED: "alwaysDisabled",
    LAZY: "lazy",
    ALWAYS_ENABLED: "alwaysEnabled",
    LAZY_ON_LAYOUT_READY: "lazyOnLayoutReady",
} as const;

export type PLUGIN_MODE = (typeof PLUGIN_MODE)[keyof typeof PLUGIN_MODE];

export function isPluginMode(value: unknown): value is PLUGIN_MODE {
    return (Object.values(PLUGIN_MODE) as unknown[]).includes(value);
}

/** Device class that owns a default profile. */
export type DeviceType = "desktop" | "mobile";
export type RestoreDraftBehavior = "ask" | "restore" | "discard";

export function isRestoreDraftBehavior(value: unknown): value is RestoreDraftBehavior {
    return value === "ask" || value === "restore" || value === "discard";
}

export const PluginModes: Record<PLUGIN_MODE, string> = {
    [PLUGIN_MODE.ALWAYS_DISABLED]: "⛔ Always disabled",
    [PLUGIN_MODE.LAZY]: "🤲 Lazy on demand",
    [PLUGIN_MODE.LAZY_ON_LAYOUT_READY]: "🚀 Lazy on layout ready",
    [PLUGIN_MODE.ALWAYS_ENABLED]: "✅ Always enabled",
};

export interface LazyOptions {
    useView: boolean;
    viewTypes: string[];
    useFile: boolean;
    fileCriteria: FileActivationCriteria;
}

export interface PluginSettings {
    mode?: PLUGIN_MODE;
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
    defaultMode: PLUGIN_MODE;
    // When true, settings/cache entries for plugin IDs no longer present in the
    // installed manifests are pruned during the manifest reconcile pass.
    pruneUninstalledEntries: boolean;
    plugins: { [pluginId: string]: PluginSettings };
    lazyOnViews: { [pluginId: string]: string[] };
    lazyOnFiles: { [pluginId: string]: FileActivationCriteria };
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
    defaultMode: PLUGIN_MODE.ALWAYS_DISABLED,
    pruneUninstalledEntries: false,
    plugins: {},
    lazyOnViews: {},
    lazyOnFiles: {},
};

/**
 * What a profile stores: only the values it overrides, the rest coming from `LazySettings.defaults`.
 * A plugin is overridden as a whole (mode, lazy options and its view/file rules together) once any
 * of `plugins`, `lazyOnViews` or `lazyOnFiles` has an entry for it.
 */
export type ProfileSettings = Partial<Pick<DeviceSettings, "defaultMode" | "pruneUninstalledEntries">> & Pick<DeviceSettings, "plugins" | "lazyOnViews" | "lazyOnFiles">;

// Settings per profile
export interface Profile {
    id: string;
    name: string;
    settings: ProfileSettings;
    /** A frozen copy (e.g. the install-time backup): it ignores `defaults` and keeps its own values only. */
    snapshot?: boolean;
}

// Global settings for the plugin
export interface LazySettings {
    showConsoleLog: boolean;
    /** How to handle an unsaved draft when its settings page is reopened; shared by all profiles. */
    restoreDraftBehavior: RestoreDraftBehavior;
    lastLazyPluginVersion?: string;
    // Reason: refusing unknown schema versions prevents older plugin builds from overwriting newer synced settings.
    settingsSchemaVersion?: number;
    profileStorageVersion?: number;

    // Profile Management
    /** Values every non-snapshot profile inherits unless it overrides them. */
    defaults: DeviceSettings;
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
/** The profile capturing the state at install time; kept as a snapshot. */
export const INITIAL_BACKUP_PROFILE_ID = "initial-backup";
/** 2: profiles store overrides on top of `defaults`. Version 1 profiles stored every value. */
export const SETTINGS_SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS: LazySettings = {
    showConsoleLog: false,
    restoreDraftBehavior: "ask",
    // A separate copy: structuredClone keeps shared references, so sharing the object with the profile would tie them together.
    defaults: structuredClone(DEFAULT_DEVICE_SETTINGS),
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
