import log from "loglevel";
import type { DataAdapter } from "obsidian";
import { Notice, Platform, normalizePath } from "obsidian";
import { loadLocalStorage } from "src/core/storage";
import type { DeviceSettings, LazySettings, Profile } from "src/core/types";
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE, SETTINGS_SCHEMA_VERSION } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { ProfileStorage } from "src/services/settings/profile-storage";

const logger = log.getLogger("OnDemandPlugin/SettingsService");
type SettingsSnapshot = { kind: "missing"; value?: undefined; fingerprint?: undefined } | { kind: "valid"; value: Record<string, unknown>; fingerprint: string } | { kind: "corrupt"; value?: undefined; fingerprint?: undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export class SettingsService {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private plugin: OnDemandPlugin;
    private profileStorage: ProfileStorage;
    private persistedFingerprint?: string;
    private writesBlocked = false;
    private saveQueue: Promise<void> = Promise.resolve();

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
        this.writesBlocked = false;
        this.persistedFingerprint = undefined;
        const snapshot = await this.readPersistedSnapshot();
        if (snapshot.kind === "corrupt") {
            this.blockSettings("The settings file is damaged. Restore a valid data.json backup, then reload the plugin.");
        }

        this.isFirstLoad = snapshot.kind === "missing";
        this.persistedFingerprint = snapshot.fingerprint;
        const loaded = (snapshot.value ?? {}) as Partial<LazySettings>;

        if (loaded.settingsSchemaVersion !== undefined && loaded.settingsSchemaVersion !== SETTINGS_SCHEMA_VERSION) {
            this.blockSettings("These settings were saved by a newer or unsupported format. Update the plugin before changing them.");
        }
        if (loaded.profileStorageVersion !== undefined && loaded.profileStorageVersion !== 1) {
            this.blockSettings("These settings use an unsupported profile storage format. Update the plugin before changing them.");
        }

        // 2. Merge with defaults (deep clone defaults first so we don't mutate
        // the shared DEFAULT_SETTINGS object during runtime edits).
        this.data = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded);

        let shouldMigrateExternalProfiles = false;
        const hasInlineProfiles = Object.hasOwn(loaded, "profiles");
        if (loaded.profileStorageVersion === 1 && !hasInlineProfiles) {
            const storedProfiles = await this.profileStorage.load();
            if (!storedProfiles.available || !storedProfiles.filesFound || storedProfiles.corruptPaths.length > 0 || !this.isValidProfileMap(storedProfiles.profiles)) {
                logger.warn("External profile migration source is missing or invalid", storedProfiles.corruptPaths);
                this.blockSettings("External profiles could not be verified. Keep the profiles folder intact and restore valid data before saving.");
            }
            this.data.profiles = storedProfiles.profiles;
            shouldMigrateExternalProfiles = true;
        } else if (hasInlineProfiles) {
            // Inline profiles are the sync source of truth. Never merge local
            // profiles/ files here, because doing so would undo synced deletions.
            if (!this.isValidProfileMap(loaded.profiles)) {
                this.blockSettings("The profiles in data.json are incomplete or damaged. Restore a valid backup before saving.");
            }
            this.data.profiles = loaded.profiles;
        } else if (isRecord(loaded.desktop) || isRecord(loaded.mobile)) {
            if ((loaded.desktop !== undefined && !this.isValidDeviceSettings(loaded.desktop)) || (loaded.mobile !== undefined && !this.isValidDeviceSettings(loaded.mobile))) {
                this.blockSettings("Legacy settings are incomplete or damaged. Restore a valid backup before saving.");
            }
        } else if (!this.isFirstLoad) {
            this.blockSettings("The settings file has no recognized profile data. Restore a valid backup before saving.");
        }
        const shouldMigrateLegacySettings = !hasInlineProfiles && !shouldMigrateExternalProfiles && (isRecord(loaded.desktop) || isRecord(loaded.mobile));

        // The old external-storage marker is removed as soon as we have a
        // verified inline source; new writes always keep the full profile map.
        delete this.data.profileStorageVersion;
        this.data.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;

        if (typeof this.data.desktopProfileId !== "string") {
            this.data.desktopProfileId = DEFAULT_PROFILE_ID;
        }
        if (typeof this.data.mobileProfileId !== "string") {
            this.data.mobileProfileId = DEFAULT_PROFILE_ID;
        }

        // 3. Migration: Convert legacy format if needed
        // Reason: older desktop/mobile keys can remain in mixed files, but inline profiles are the newer sync source of truth.
        if (shouldMigrateLegacySettings) this.migrateLegacySettings();

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
        // Reason: store2 is a legacy fallback and may hydrate only a recognized desktop/mobile legacy file.
        if (shouldMigrateLegacySettings) {
            const storedViews = loadLocalStorage<Record<string, string[]>>(this.plugin.app, "lazyOnViews");
            if (storedViews && Object.keys(storedViews).length > 0) {
                this.settings.lazyOnViews = {
                    ...(this.settings.lazyOnViews ?? {}),
                    ...(storedViews as { [k: string]: string[] }),
                };
            }
        }

        if (shouldMigrateExternalProfiles) {
            try {
                await this.save();
            } catch (error) {
                if (this.writesBlocked) throw error;
                logger.warn("Failed to migrate external profiles into data.json", error);
            }
        }
    }

    private async readPersistedSnapshot(): Promise<SettingsSnapshot> {
        const candidate = this.plugin as unknown as {
            app?: { vault?: { adapter?: DataAdapter } };
            manifest?: { dir?: string };
            loadData(): Promise<unknown>;
        };
        const adapter = candidate.app?.vault?.adapter;
        const dir = candidate.manifest?.dir;

        if (adapter && dir) {
            const dataPath = normalizePath(`${dir}/data.json`);
            try {
                if (!(await adapter.exists(dataPath))) return { kind: "missing" };
                const value: unknown = JSON.parse(await adapter.read(dataPath));
                if (!isRecord(value)) return { kind: "corrupt" };
                return { kind: "valid", value, fingerprint: stableStringify(value) };
            } catch {
                return { kind: "corrupt" };
            }
        }

        try {
            const value: unknown = await candidate.loadData();
            if (value === null || value === undefined) return { kind: "missing" };
            if (!isRecord(value)) return { kind: "corrupt" };
            return { kind: "valid", value, fingerprint: stableStringify(value) };
        } catch {
            return { kind: "corrupt" };
        }
    }

    private isValidProfileMap(value: unknown): value is Record<string, Profile> {
        if (!isRecord(value) || Object.keys(value).length === 0) return false;
        return Object.entries(value).every(([key, profile]) => {
            return isRecord(profile) && profile.id === key && typeof profile.name === "string" && this.isValidDeviceSettings(profile.settings);
        });
    }

    private isValidDeviceSettings(value: unknown): value is DeviceSettings {
        if (!isRecord(value)) return false;
        if (value.defaultMode !== undefined && !Object.values(PLUGIN_MODE).includes(value.defaultMode as (typeof PLUGIN_MODE)[keyof typeof PLUGIN_MODE])) return false;
        if (value.pruneUninstalledEntries !== undefined && typeof value.pruneUninstalledEntries !== "boolean") return false;
        return ["plugins", "lazyOnViews", "lazyOnFiles"].every((key) => value[key] === undefined || isRecord(value[key]));
    }

    private blockSettings(message: string): never {
        this.writesBlocked = true;
        new Notice(message);
        throw new Error(message);
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
        // Reason: serialize snapshots so concurrent setting changes cannot race the disk fingerprint and overwrite one another.
        const pendingSave = this.saveQueue.then(() => this.saveNow());
        this.saveQueue = pendingSave.catch(() => undefined);
        await pendingSave;
    }

    private async saveNow() {
        if (this.writesBlocked || !this.data || !this.settings || !this.currentProfileId) {
            throw new Error("Settings cannot be saved until a valid settings file is loaded.");
        }

        const latest = await this.readPersistedSnapshot();
        if (latest.kind === "corrupt") {
            this.blockSettings("The settings file changed into an unreadable state. Restore a valid backup, then reload the plugin.");
        }
        const expectedMissing = this.persistedFingerprint === undefined;
        const currentMissing = latest.kind === "missing";
        // Reason: Obsidian Sync can deliver a newer data.json after load; compare before save to avoid replacing that copy.
        if (expectedMissing !== currentMissing || (!currentMissing && latest.kind === "valid" && latest.fingerprint !== this.persistedFingerprint)) {
            this.blockSettings("Settings changed on disk after this plugin loaded. Reload the plugin before saving to avoid overwriting newer data.");
        }

        // Ensure the current settings are reflected in the data object
        // (Since this.settings is a reference, it should be, but good to be safe)
        if (this.data.profiles[this.currentProfileId]) {
            this.data.profiles[this.currentProfileId].settings = this.settings;
        }
        if (!this.isValidProfileMap(this.data.profiles)) {
            this.blockSettings("The in-memory profiles are incomplete. Restore a valid backup before saving.");
        }

        const persisted = structuredClone(this.data);
        delete persisted.profileStorageVersion;
        persisted.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
        // Keep every profile in Obsidian's plugin data.json so Sync transfers the
        // complete configuration in one file; profiles/ remains the old migration copy for manual recovery.
        await this.plugin.saveData(persisted);
        this.persistedFingerprint = stableStringify(persisted);
        this.isFirstLoad = false;
        // Reason: profile dialogs save through this service directly, so central emission keeps every successful save backed up.
        this.plugin.app.workspace.trigger("ondemand-plugins:settings-saved");
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
