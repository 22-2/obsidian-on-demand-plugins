import log from "loglevel";
import { Platform } from "obsidian";
import { loadLocalStorage } from "src/core/storage";
import type { DeviceSettings, LazySettings, Profile } from "src/core/types";
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { ProfileStorage } from "src/services/settings/profile-storage";

const logger = log.getLogger("OnDemandPlugin/SettingsService");

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export class SettingsService {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private plugin: OnDemandPlugin;
    private profileStorage: ProfileStorage;
    private profileStorageEnabled = false;

    // Populated in load().
    data!: LazySettings;
    /** Currently active device settings (points to the active profile's settings) */
    // Populated in load() after profile resolution.
    settings!: DeviceSettings;
    /** ID of the currently active profile */
    // Populated in load() after profile resolution.
    currentProfileId!: string;
    /** True if no previous data.json was found during load */
    isFirstLoad = false;

    constructor(plugin: OnDemandPlugin) {
        this.plugin = plugin;
        this.profileStorage = new ProfileStorage(plugin);
    }

    async load() {
        // 1. Load raw data
        const rawLoaded: unknown = await this.plugin.loadData();
        const loaded = isRecord(rawLoaded) ? (rawLoaded as Partial<LazySettings>) : {};
        this.isFirstLoad = Object.keys(loaded).length === 0;

        // 2. Merge with defaults (deep clone defaults first so we don't mutate
        // the shared DEFAULT_SETTINGS object during runtime edits).
        this.data = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded);

        const storedProfiles = await this.profileStorage.load();
        this.profileStorageEnabled = storedProfiles.available;
        const hasExternalStorageMarker = loaded.profileStorageVersion === 1;
        const legacyProfiles = isRecord(this.data.profiles) ? this.data.profiles : {};
        let shouldMigrateProfiles = storedProfiles.available && !hasExternalStorageMarker;

        if (Object.keys(storedProfiles.profiles).length > 0) {
            this.data.profiles = hasExternalStorageMarker ? storedProfiles.profiles : { ...legacyProfiles, ...storedProfiles.profiles };
        } else if (hasExternalStorageMarker && storedProfiles.filesFound) {
            // Keep the normalizer below from treating the default template as a
            // valid external profile when every stored profile is corrupt.
            this.data.profiles = {};
        }

        if (storedProfiles.corruptPaths.length > 0) {
            logger.warn("Some external profile files could not be read", storedProfiles.corruptPaths);
        }

        // 2b. Ensure top-level profile references are valid before migration.
        // First drop any corrupt (null/non-object) profile entries so a later
        // `profiles[id].settings` read can't throw. An empty object is a valid
        // record but has no profiles to activate, so treat "no usable profiles"
        // (missing map, or all entries pruned) the same as a fresh install and
        // seed the Default profile.
        if (isRecord(this.data.profiles)) {
            for (const [id, profile] of Object.entries(this.data.profiles)) {
                if (!isRecord(profile)) {
                    delete this.data.profiles[id];
                }
            }
        }
        if (!isRecord(this.data.profiles) || Object.keys(this.data.profiles).length === 0) {
            this.data.profiles = {
                [DEFAULT_PROFILE_ID]: {
                    id: DEFAULT_PROFILE_ID,
                    name: DEFAULT_PROFILE_ID,
                    settings: structuredClone(DEFAULT_DEVICE_SETTINGS),
                },
            };
        }
        if (typeof this.data.desktopProfileId !== "string") {
            this.data.desktopProfileId = DEFAULT_PROFILE_ID;
        }
        if (typeof this.data.mobileProfileId !== "string") {
            this.data.mobileProfileId = DEFAULT_PROFILE_ID;
        }

        // 3. Migration: Convert legacy format if needed
        this.migrateLegacySettings();

        // 4. Determine which profile to activate
        // By default, pick the one assigned to the current platform
        const defaultId = Platform.isMobile ? this.data.mobileProfileId : this.data.desktopProfileId;

        // If for some reason the ID doesn't exist, fallback to the first available or default
        if (!this.data.profiles[defaultId]) {
            const firstId = Object.keys(this.data.profiles)[0];
            this.currentProfileId = firstId || DEFAULT_PROFILE_ID;
        } else {
            this.currentProfileId = defaultId;
        }

        // 5. Ensure all profiles have all required settings and nested maps
        Object.values(this.data.profiles).forEach((profile) => {
            this.normalizeProfileSettings(profile);
        });

        // 5b. Drop dead command-cache fields. These were persisted in data.json by
        // older versions; the live cache now lives in vault-scoped storage, so any
        // copy here is stale bloat. Removed wholesale (the profiles migration's
        // delete pattern) instead of pruned per plugin ID, and runs every load so
        // already-migrated installs get cleaned too.
        delete this.data.commandCache;
        delete this.data.commandCacheVersions;
        delete (this.data as unknown as Record<string, unknown>).suppressPluginManagementNotice;

        // 6. Set the active settings reference
        this.settings = this.data.profiles[this.currentProfileId].settings;

        // 6. Legacy: Hydrate lazyOnViews from store2 (if applicable)
        // This was logic from the previous version to sync view state across vaults?
        // Or specific local storage? Keeping purely for backward compat if needed,
        // but generally profiles should store this now.
        // The original code merged `loadJSON(app, "lazyOnViews")`.
        // We can keep this behavior for the active profile to maintain continuity.
        const storedViews = loadLocalStorage<Record<string, string[]>>(this.plugin.app, "lazyOnViews");
        if (storedViews && Object.keys(storedViews).length > 0) {
            this.settings.lazyOnViews = {
                ...(this.settings.lazyOnViews ?? {}),
                ...(storedViews as { [k: string]: string[] }),
            };
        }

        if (shouldMigrateProfiles) {
            try {
                await this.save();
            } catch (error) {
                logger.warn("Failed to migrate profiles to external storage; keeping data.json fallback", error);
            }
        }
    }

    private migrateLegacySettings() {
        // If we already have profiles, we assume migration is done
        if (
            this.data.profiles &&
            Object.keys(this.data.profiles).length > 0 &&
            // Check if it's the default dummy profile but we have legacy data to migrate
            !(Object.keys(this.data.profiles).length === 1 && this.data.profiles[DEFAULT_PROFILE_ID] && (this.data.desktop || this.data.mobile))
        ) {
            return;
        }

        // Check if we have legacy data to migrate
        if (!this.data.desktop && !this.data.mobile) {
            // No legacy data, standard default is fine
            return;
        }

        logger.debug("[Lazy Plugin] Migrating legacy settings to profiles...");

        const profiles: Record<string, Profile> = {};

        // Migrate Desktop
        const desktopSettings = Object.assign({}, DEFAULT_DEVICE_SETTINGS, this.data.desktop || {});
        const desktopId = "Default";
        profiles[desktopId] = {
            id: desktopId,
            name: "Default (desktop)",
            settings: desktopSettings,
        };

        // Migrate Mobile
        let mobileId = desktopId;
        if (this.data.dualConfigs && this.data.mobile) {
            mobileId = "mobile";
            const mobileSettings = Object.assign({}, DEFAULT_DEVICE_SETTINGS, this.data.mobile || {});
            profiles[mobileId] = {
                id: mobileId,
                name: "Mobile",
                settings: mobileSettings,
            };
        }

        this.data.profiles = profiles;
        this.data.desktopProfileId = desktopId;
        this.data.mobileProfileId = mobileId;

        // Clean up legacy fields
        delete this.data.desktop;
        delete this.data.mobile;
        delete this.data.dualConfigs;
    }

    private normalizeProfileSettings(profile: Profile) {
        if (!profile.settings || typeof profile.settings !== "object") {
            profile.settings = structuredClone(DEFAULT_DEVICE_SETTINGS);
            return;
        }

        if (profile.settings.defaultMode === undefined) {
            profile.settings.defaultMode = DEFAULT_DEVICE_SETTINGS.defaultMode;
        }
        if (profile.settings.pruneUninstalledEntries === undefined) {
            profile.settings.pruneUninstalledEntries = DEFAULT_DEVICE_SETTINGS.pruneUninstalledEntries;
        }
        // This setting was removed; discard it from profiles created by older versions.
        delete (profile.settings as unknown as Record<string, unknown>).showDescriptions;
        if (!isRecord(profile.settings.plugins)) {
            profile.settings.plugins = {};
        }
        if (!isRecord(profile.settings.lazyOnViews)) {
            profile.settings.lazyOnViews = {};
        }
        if (!isRecord(profile.settings.lazyOnFiles)) {
            profile.settings.lazyOnFiles = {};
        }
    }

    async save() {
        // Ensure the current settings are reflected in the data object
        // (Since this.settings is a reference, it should be, but good to be safe)
        if (this.data.profiles[this.currentProfileId]) {
            this.data.profiles[this.currentProfileId].settings = this.settings;
        }
        if (!this.profileStorageEnabled) {
            await this.plugin.saveData(this.data);
            return;
        }

        try {
            await this.profileStorage.save(this.data.profiles);
            const persisted = { ...this.data } as Partial<LazySettings>;
            delete persisted.profiles;
            persisted.profileStorageVersion = 1;
            await this.plugin.saveData(persisted);
        } catch (error) {
            // Keep a complete data.json fallback if external storage is not
            // writable. The next load can retry migration without losing data.
            logger.warn("Failed to save external profiles; writing data.json fallback", error);
            const fallback = { ...this.data } as Partial<LazySettings>;
            delete fallback.profileStorageVersion;
            await this.plugin.saveData(fallback);
        }
    }

    /**
     * Switch the active profile in the current session.
     * Does NOT change the default profile for the device (desktopProfileId/mobileProfileId)
     * unless explicitly requested.
     */
    switchProfile(profileId: string) {
        if (!this.data.profiles[profileId]) {
            throw new Error(`Profile ${profileId} not found`);
        }
        this.currentProfileId = profileId;
        this.settings = this.data.profiles[profileId].settings;

        // Update the default ID for this device type so it persists after restart
        if (Platform.isMobile) {
            this.data.mobileProfileId = profileId;
        } else {
            this.data.desktopProfileId = profileId;
        }
    }

    createProfile(name: string, sourceProfileId?: string): string {
        // Use activeWindow for UUID generation so popout-window contexts share the same compatibility path.
        const newId = activeWindow.crypto.randomUUID();
        const sourceSettings = sourceProfileId && this.data.profiles[sourceProfileId] ? this.data.profiles[sourceProfileId].settings : DEFAULT_DEVICE_SETTINGS;

        // Deep copy settings to avoid reference issues
        const newSettings = structuredClone(sourceSettings);

        this.data.profiles[newId] = {
            id: newId,
            name: name,
            settings: newSettings,
        };
        return newId;
    }

    deleteProfile(profileId: string) {
        if (Object.keys(this.data.profiles).length <= 1) {
            throw new Error("Cannot delete the last profile");
        }
        if (profileId === this.currentProfileId) {
            throw new Error("Cannot delete the active profile");
        }
        delete this.data.profiles[profileId];
    }

    renameProfile(profileId: string, newName: string) {
        if (this.data.profiles[profileId]) {
            this.data.profiles[profileId].name = newName;
        }
    }

    setDeviceDefault(profileId: string, type: "desktop" | "mobile") {
        if (!this.data.profiles[profileId]) return;

        if (type === "desktop") {
            this.data.desktopProfileId = profileId;
        } else {
            this.data.mobileProfileId = profileId;
        }
    }
}
