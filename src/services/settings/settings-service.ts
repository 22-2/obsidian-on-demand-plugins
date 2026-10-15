import log from "loglevel";
import type { DataAdapter } from "obsidian";
import { Notice, Platform, normalizePath } from "obsidian";
import { loadLocalStorage } from "src/core/storage";
import type { DeviceSettings, DeviceType, LazySettings, Profile, ProfileSettings } from "src/core/types";
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, INITIAL_BACKUP_PROFILE_ID, SETTINGS_SCHEMA_VERSION, isPluginMode, isRestoreDraftBehavior } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { ProfileStorage } from "src/services/settings/profile-storage";
import { pluginLayerToEdit, resolveEffectiveSettings } from "src/services/settings/settings-layers";

const logger = log.getLogger("OnDemandPlugin/SettingsService");
type SettingsSnapshot = { kind: "missing"; value?: undefined; fingerprint?: undefined } | { kind: "valid"; value: Record<string, unknown>; fingerprint: string } | { kind: "corrupt"; value?: undefined; fingerprint?: undefined };

type ProfileSource = "external" | "inline" | "legacy" | "fresh";
/** Fields older versions wrote to data.json that are no longer part of LazySettings. */
type LegacyDeadFields = { suppressPluginManagementNotice?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
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
    // Computed from the active profile and the shared defaults on every read.
    get settings(): DeviceSettings {
        return resolveEffectiveSettings(this.activeProfile, this.data.defaults);
    }
    /** The active profile; edits to its `settings` are what the active profile overrides. */
    get activeProfile(): Profile {
        return this.data.profiles[this.currentProfileId];
    }
    /** The live layer a user edit of a plugin goes to: the active profile, which then overrides the plugin. */
    pluginLayerForEdit(pluginId: string): ProfileSettings {
        return pluginLayerToEdit(this.data, this.currentProfileId, pluginId);
    }
    /** ID of the currently active profile */
    // Populated in load() after profile resolution.
    currentProfileId!: string;
    /** True if no previous data.json was found during load */
    isFirstLoad = false;
    /**
     * The settings as last loaded or saved, whichever path saved them. The settings
     * draft is compared against this, and changes that must not carry the draft are
     * saved on top of it. Treat it as read-only.
     */
    persisted?: LazySettings;

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
        this.assertSupportedFormat(loaded);

        // Deep clone defaults first so runtime edits never mutate the shared DEFAULT_SETTINGS object.
        this.data = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded);
        const source = await this.resolveProfileSource(loaded);

        // The old external-storage marker is removed as soon as we have a
        // verified inline source; new writes always keep the full profile map.
        delete this.data.profileStorageVersion;
        this.data.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
        if (typeof this.data.desktopProfileId !== "string") this.data.desktopProfileId = DEFAULT_PROFILE_ID;
        if (typeof this.data.mobileProfileId !== "string") this.data.mobileProfileId = DEFAULT_PROFILE_ID;

        // Older desktop/mobile keys can remain in mixed files, but inline profiles are the newer sync source of truth.
        if (source === "legacy") this.migrateLegacySettings();

        this.currentProfileId = this.selectActiveProfileId();
        this.normalizeRestoreDraftBehavior(loaded);
        this.normalizeLayers(loaded);
        this.dropDeadFields();

        if (source === "legacy") this.hydrateLegacyLazyOnViews();
        // Reason: nothing is saved yet on a first load, and startup keeps its defaults in memory on purpose,
        // so the settings tab baselines on the state it first sees until the first save.
        this.persisted = this.isFirstLoad ? undefined : structuredClone(this.data);
        if (source === "external") await this.persistExternalProfileMigration();
    }

    private assertSupportedFormat(loaded: Partial<LazySettings>) {
        // Older versions are migrated on load; only a newer one is refused, so this build never overwrites it.
        const version = loaded.settingsSchemaVersion;
        if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > SETTINGS_SCHEMA_VERSION)) {
            this.blockSettings("These settings were saved by a newer or unsupported format. Update the plugin before changing them.");
        }
        if (loaded.profileStorageVersion !== undefined && loaded.profileStorageVersion !== 1) {
            this.blockSettings("These settings use an unsupported profile storage format. Update the plugin before changing them.");
        }
    }

    /**
     * Decides where profiles come from and validates that source, populating
     * this.data.profiles when it is not plain data.json defaults.
     * - external: profileStorageVersion 1 without inline profiles (profiles/ folder)
     * - inline: profiles stored in data.json (the sync source of truth)
     * - legacy: pre-profile desktop/mobile keys that still need migration
     * - fresh: first run with no data.json
     */
    private async resolveProfileSource(loaded: Partial<LazySettings>): Promise<ProfileSource> {
        const hasInlineProfiles = Object.hasOwn(loaded, "profiles");
        if (loaded.profileStorageVersion === 1 && !hasInlineProfiles) {
            const storedProfiles = await this.profileStorage.load();
            if (!storedProfiles.available || !storedProfiles.filesFound || storedProfiles.corruptPaths.length > 0 || !this.isValidProfileMap(storedProfiles.profiles)) {
                logger.warn("External profile migration source is missing or invalid", storedProfiles.corruptPaths);
                this.blockSettings("External profiles could not be verified. Keep the profiles folder intact and restore valid data before saving.");
            }
            this.data.profiles = storedProfiles.profiles;
            return "external";
        }
        if (hasInlineProfiles) {
            // Never merge local profiles/ files here, because doing so would undo synced deletions.
            if (!this.isValidProfileMap(loaded.profiles)) {
                this.blockSettings("The profiles in data.json are incomplete or damaged. Restore a valid backup before saving.");
            }
            this.data.profiles = loaded.profiles;
            return "inline";
        }
        if (isRecord(loaded.desktop) || isRecord(loaded.mobile)) {
            if ((loaded.desktop !== undefined && !this.isValidDeviceSettings(loaded.desktop)) || (loaded.mobile !== undefined && !this.isValidDeviceSettings(loaded.mobile))) {
                this.blockSettings("Legacy settings are incomplete or damaged. Restore a valid backup before saving.");
            }
            return "legacy";
        }
        if (!this.isFirstLoad) {
            this.blockSettings("The settings file has no recognized profile data. Restore a valid backup before saving.");
        }
        return "fresh";
    }

    /** Prefer the profile assigned to this platform, falling back to the first available one. */
    private selectActiveProfileId(): string {
        const defaultId = Platform.isMobile ? this.data.mobileProfileId : this.data.desktopProfileId;
        if (this.data.profiles[defaultId]) return defaultId;
        return Object.keys(this.data.profiles)[0] || DEFAULT_PROFILE_ID;
    }

    /**
     * Older versions persisted command-cache fields in data.json; the live cache
     * now lives in vault-scoped storage, so any copy here is stale bloat. Runs on
     * every load so already-migrated installs get cleaned too.
     */
    /** Pre-release builds stored this per profile; adopt the active profile's value once, then keep it shared. */
    private normalizeRestoreDraftBehavior(loaded: Partial<LazySettings>) {
        const fromProfile = (this.data.profiles[this.currentProfileId]?.settings as unknown as Partial<Record<string, unknown>> | undefined)?.restoreDraftBehavior;
        if (!Object.hasOwn(loaded, "restoreDraftBehavior") && isRestoreDraftBehavior(fromProfile)) this.data.restoreDraftBehavior = fromProfile;
        if (!isRestoreDraftBehavior(this.data.restoreDraftBehavior)) this.data.restoreDraftBehavior = DEFAULT_SETTINGS.restoreDraftBehavior;
        for (const profile of Object.values(this.data.profiles)) delete (profile.settings as unknown as Partial<Record<string, unknown>>).restoreDraftBehavior;
    }

    private dropDeadFields() {
        const data: LazySettings & LegacyDeadFields = this.data;
        delete data.commandCache;
        delete data.commandCacheVersions;
        delete data.suppressPluginManagementNotice;
    }

    /** Legacy installs kept lazyOnViews in localStorage (store2); merge it into the migrated active profile once. */
    private hydrateLegacyLazyOnViews() {
        const storedViews = loadLocalStorage<Record<string, string[]>>(this.plugin.app, "lazyOnViews");
        if (!storedViews || Object.keys(storedViews).length === 0) return;
        const settings = this.activeProfile.settings;
        settings.lazyOnViews = {
            ...(settings.lazyOnViews ?? {}),
            ...storedViews,
        };
    }

    private async persistExternalProfileMigration() {
        try {
            await this.save();
        } catch (error) {
            if (this.writesBlocked) throw error;
            logger.warn("Failed to migrate external profiles into data.json", error);
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
        if (value.defaultMode !== undefined && !isPluginMode(value.defaultMode)) return false;
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

    /**
     * Version 1 profiles stored every value. They keep all of them as overrides on top of
     * built-in defaults, so each profile runs exactly as before; nothing is inherited until the
     * user moves values to the defaults. Version 2 profiles keep their overrides as they are.
     */
    private normalizeLayers(loaded: Partial<LazySettings>) {
        const layered = (loaded.settingsSchemaVersion ?? 1) >= 2;
        if (layered) {
            if (!this.isValidDeviceSettings(loaded.defaults)) {
                this.blockSettings("The default settings in data.json are missing or damaged. Restore a valid backup before saving.");
            }
            this.data.defaults = loaded.defaults;
            this.normalizeSettingsLayer(this.data.defaults, true);
        } else {
            this.data.defaults = structuredClone(DEFAULT_DEVICE_SETTINGS);
            // The install-time backup must not change when defaults change later.
            const backup = this.data.profiles[INITIAL_BACKUP_PROFILE_ID];
            if (backup) backup.snapshot = true;
        }
        for (const profile of Object.values(this.data.profiles)) {
            if (typeof profile.snapshot !== "boolean") delete profile.snapshot;
            // A snapshot has no defaults to inherit, and version 1 profiles always held every value.
            this.normalizeProfileSettings(profile, !layered || profile.snapshot === true);
        }
    }

    private normalizeProfileSettings(profile: Profile, fillValues: boolean) {
        if (!isRecord(profile.settings)) {
            profile.settings = structuredClone(DEFAULT_DEVICE_SETTINGS);
            return;
        }
        this.normalizeSettingsLayer(profile.settings, fillValues);
    }

    /** Fills a layer's maps; `fillValues` also fills unset profile-wide values with built-in defaults. */
    private normalizeSettingsLayer(settings: ProfileSettings, fillValues: boolean) {
        if (fillValues && settings.defaultMode === undefined) {
            settings.defaultMode = DEFAULT_DEVICE_SETTINGS.defaultMode;
        }
        if (fillValues && settings.pruneUninstalledEntries === undefined) {
            settings.pruneUninstalledEntries = DEFAULT_DEVICE_SETTINGS.pruneUninstalledEntries;
        }
        // This setting was removed; discard it from profiles created by older versions.
        delete (settings as unknown as Record<string, unknown>).showDescriptions;
        if (!isRecord(settings.plugins)) {
            settings.plugins = {};
        }
        if (!isRecord(settings.lazyOnViews)) {
            settings.lazyOnViews = {};
        }
        if (!isRecord(settings.lazyOnFiles)) {
            settings.lazyOnFiles = {};
        }
    }

    async save(snapshot?: LazySettings) {
        // Reason: serialize snapshots so concurrent setting changes cannot race the disk fingerprint and overwrite one another.
        const savedSnapshot = snapshot ? structuredClone(snapshot) : undefined;
        const pendingSave = this.saveQueue.then(() => this.saveNow(savedSnapshot));
        this.saveQueue = pendingSave.catch(() => undefined);
        await pendingSave;
    }

    private async saveNow(snapshot?: LazySettings) {
        if (this.writesBlocked || !this.data || !this.currentProfileId) {
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

        const persisted = structuredClone(snapshot ?? this.data);
        if (!this.isValidProfileMap(persisted.profiles)) {
            this.blockSettings("The in-memory profiles are incomplete. Restore a valid backup before saving.");
        }

        delete persisted.profileStorageVersion;
        persisted.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
        // Keep every profile in Obsidian's plugin data.json so Sync transfers the
        // complete configuration in one file; profiles/ remains the old migration copy for manual recovery.
        await this.plugin.saveData(persisted);
        this.persistedFingerprint = stableStringify(persisted);
        this.persisted = persisted;
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

    setDeviceDefault(profileId: string, type: DeviceType) {
        if (!this.data.profiles[profileId]) return;

        if (type === "desktop") {
            this.data.desktopProfileId = profileId;
        } else {
            this.data.mobileProfileId = profileId;
        }
    }
}
