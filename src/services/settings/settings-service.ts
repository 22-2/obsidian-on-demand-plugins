import { Platform } from "obsidian";
import { loadJSON } from "../../core/storage";
import type { DeviceSettings, LazySettings, Profile } from "../../core/types";
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS } from "../../core/types";
import type OnDemandPlugin from "../../main";

export class SettingsService {
    data: LazySettings;
    /** Currently active device settings (points to the active profile's settings) */
    settings: DeviceSettings;
    /** ID of the currently active profile */
    currentProfileId: string;

    constructor(private plugin: OnDemandPlugin) {}

    async load() {
        // 1. Load raw data
        const loaded = (await this.plugin.loadData()) || {};

        // 2. Merge with defaults (shallow merge at top level)
        // We need to be careful not to overwrite existing profiles if they exist
        this.data = Object.assign({}, DEFAULT_SETTINGS, loaded);

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

        // 5. Set the active settings reference
        this.settings = this.data.profiles[this.currentProfileId].settings;

        // 6. Legacy: Hydrate lazyOnViews from store2 (if applicable)
        // This was logic from the previous version to sync view state across vaults?
        // Or specific local storage? Keeping purely for backward compat if needed,
        // but generally profiles should store this now.
        // The original code merged `loadJSON(app, "lazyOnViews")`.
        // We can keep this behavior for the active profile to maintain continuity.
        const storedViews = loadJSON<Record<string, string[]>>(this.plugin.app, "lazyOnViews");
        if (storedViews && Object.keys(storedViews).length > 0) {
            this.settings.lazyOnViews = {
                ...(this.settings.lazyOnViews ?? {}),
                ...(storedViews as { [k: string]: string[] }),
            };
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

        console.log("[Lazy Plugin] Migrating legacy settings to profiles...");

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

    async save() {
        // Ensure the current settings are reflected in the data object
        // (Since this.settings is a reference, it should be, but good to be safe)
        if (this.data.profiles[this.currentProfileId]) {
            this.data.profiles[this.currentProfileId].settings = this.settings;
        }
        await this.plugin.saveData(this.data);
    }

    /**
     * Switch the active profile in the current session.
     * Does NOT change the default profile for the device (desktopProfileId/mobileProfileId)
     * unless explicitly requested.
     */
    async switchProfile(profileId: string) {
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
        const newId = crypto.randomUUID();
        const sourceSettings = sourceProfileId && this.data.profiles[sourceProfileId] ? this.data.profiles[sourceProfileId].settings : DEFAULT_DEVICE_SETTINGS;

        // Deep copy settings to avoid reference issues
        const newSettings = JSON.parse(JSON.stringify(sourceSettings));

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
