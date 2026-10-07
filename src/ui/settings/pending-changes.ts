import type { LazySettings } from "src/core/types";
import { stableStringify } from "src/services/settings/settings-service";

type DraftSource = {
    readonly data?: LazySettings;
    readonly currentProfileId: string;
};

/**
 * Tracks the unsaved settings draft by diffing the live settings against a
 * snapshot taken at the last save/reload. Kept free of Obsidian UI so the
 * dirty-state rules can be unit tested.
 */
export class PendingChanges {
    readonly pluginIds = new Set<string>();
    private baselineData?: LazySettings;
    private baselineFingerprint?: string;
    private readonly getSource: () => DraftSource | undefined;

    constructor(getSource: () => DraftSource | undefined) {
        this.getSource = getSource;
        this.captureBaseline();
    }

    get hasChanges(): boolean {
        // Compare the live draft against the last saved baseline so touching a
        // control and reverting it back leaves no pending change.
        const source = this.getSource();
        if (!source?.data) return this.pluginIds.size > 0;
        this.ensureBaseline();
        return stableStringify(source.data) !== this.baselineFingerprint;
    }

    /** Plugin IDs whose staged entry actually differs from the baseline, so reverted rows are not applied. */
    getChangedPluginIds(): string[] {
        const source = this.getSource();
        if (!source?.data || !this.baselineData) return Array.from(this.pluginIds);
        const profileId = source.currentProfileId;
        const currentPlugins = source.data.profiles[profileId]?.settings.plugins ?? {};
        const baselinePlugins = this.baselineData.profiles[profileId]?.settings.plugins ?? {};
        const ids = new Set([...Object.keys(currentPlugins), ...Object.keys(baselinePlugins)]);
        return [...ids].filter((id) => stableStringify(currentPlugins[id]) !== stableStringify(baselinePlugins[id]));
    }

    markDirty() {
        // Dirty state is derived from the baseline diff, so just ensure the baseline exists.
        // Callers invoke this after mutating settings; never recapture here or the edit would compare against itself.
        this.ensureBaseline();
    }

    reset() {
        this.pluginIds.clear();
        // Re-baseline to the current (saved or reloaded) state so earlier edits no longer count as pending.
        this.captureBaseline();
    }

    private ensureBaseline() {
        if (this.baselineData === undefined || this.baselineFingerprint === undefined) this.captureBaseline();
    }

    private captureBaseline() {
        const data = this.getSource()?.data;
        if (!data) return;
        // Deep clone so later in-memory edits cannot mutate the comparison source.
        this.baselineData = structuredClone(data);
        this.baselineFingerprint = stableStringify(data);
    }
}
