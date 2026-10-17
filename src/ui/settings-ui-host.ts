import type { App, PluginManifest } from "obsidian";
import type { DeviceSettings, LazySettings, PLUGIN_MODE } from "src/core/types";
import type { CommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import type { MaintenanceFeature } from "src/features/maintenance/maintenance-feature";
import type { DraftSource } from "src/ui/settings/pending-changes";

/** The maintenance operations the Maintenance page runs. */
export type MaintenanceOperations = Pick<MaintenanceFeature, "rebuildAndApplyCommandCache" | "buildSyncPreview" | "executeSync" | "applyBatchModeReplace">;

/**
 * Everything the settings UI may use from On-Demand. The pages, modals and the
 * draft never reach the core services or the features directly, so those can
 * change without touching the UI, and the UI can be tested against a plain object.
 */
export interface SettingsUiHost {
    readonly app: App;
    /** On-Demand's own manifest. */
    readonly manifest: PluginManifest;
    /** The live settings, which the settings draft edits in place. */
    readonly data: LazySettings;
    /** The active profile's settings within `data`. */
    readonly settings: DeviceSettings;
    /** Installed plugins other than On-Demand, as of the last `updateManifests`. */
    readonly manifests: PluginManifest[];
    readonly currentProfileId: string;

    updateManifests(): void;
    getPluginMode(pluginId: string): PLUGIN_MODE;
    isPluginEnabledOnDisk(pluginId: string): boolean;
    configureLogger(): void;

    /** The saved settings the draft is compared against; undefined before settings load. */
    getDraftSource(): DraftSource | undefined;
    /** Saves the live settings, or `snapshot` in their place. */
    saveSettings(snapshot?: LazySettings): Promise<void>;
    /** Reloads the saved settings over the live ones. */
    loadSettings(): Promise<void>;
    /** Resolves false when the user keeps the profile because applying it would overwrite external edits. */
    switchProfile(profileId: string): Promise<boolean>;

    /** Applies the saved modes of these plugins and restarts as needed. */
    applyPolicies(pluginIds: string[], options?: { externalChangesConfirmed?: boolean }): Promise<void>;
    /** Asks before overwriting external edits to community-plugins.json; true when there are none or the user agrees. */
    confirmExternalOverwrite(): Promise<boolean>;
    /** External edits to community-plugins.json, or null when there are none or they cannot be read. */
    detectExternalChanges(): Promise<CommunityPluginsDrift | null>;
    /** Rebuilds one plugin's command and view caches; false when the startup policy is not available. */
    rebuildPluginCaches(pluginId: string): Promise<boolean>;
    createBackup(): Promise<void>;
    /** Undefined when the maintenance feature is not loaded. */
    readonly maintenance: MaintenanceOperations | undefined;

    openPluginTable(): Promise<void>;
}
