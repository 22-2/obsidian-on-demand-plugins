import type { DeviceSettings, LazySettings, PLUGIN_MODE, PluginSettings, RestoreDraftBehavior } from "src/core/types";
import { PluginModes } from "src/core/types";
import { stableStringify } from "src/services/settings/settings-service";

type DraftSource = {
    readonly data?: LazySettings;
    readonly currentProfileId: string;
    /** Last loaded or saved settings; when present it is the baseline, so saves made elsewhere never go stale here. */
    readonly persisted?: LazySettings;
};

/** "external" lists edits made outside On-Demand that saving overwrites; they are never part of the draft. */
export type PendingChangeGroup = "plugins" | "settings" | "profiles" | "external";

export type PendingChange = {
    group: PendingChangeGroup;
    label: string;
    /** Saved value; omitted when the item did not exist before. */
    from?: string;
    to: string;
    /** Restores the saved value; omitted when the item cannot be undone on its own. */
    revert?: () => void;
};

export type ChangeDescriber = {
    pluginName: (pluginId: string) => string;
    /** Mode a plugin without an explicit entry resolves to, mirroring the plugin's own fallback. */
    fallbackMode: (pluginId: string, settings: DeviceSettings) => PLUGIN_MODE;
};

export type ImmediateSettingsChange = (data: LazySettings, profileId: string) => void | Promise<void>;

/** An unsaved draft taken out of the live settings: the draft and the saved settings it was made against. */
export type DraftStash = {
    readonly draft: LazySettings;
    readonly base: LazySettings;
    readonly currentProfileId: string;
};

/** Top-level keys described explicitly; any other differing key is reported generically so nothing pending stays hidden. */
const DESCRIBED_ROOT_KEYS = new Set<string>(["profiles", "desktopProfileId", "mobileProfileId", "showConsoleLog"]);
const DESCRIBED_DEVICE_KEYS = new Set<string>(["plugins", "defaultMode", "pruneUninstalledEntries", "restoreDraftBehavior"]);
const DEVICE_KEY_LABELS: Record<string, string> = {
    lazyOnViews: "View activation rules",
    lazyOnFiles: "File activation rules",
};
const RESTORE_DRAFT_BEHAVIOR_LABELS: Record<RestoreDraftBehavior, string> = {
    ask: "Ask every time",
    restore: "Always restore",
    discard: "Always discard",
};

const onOff = (value: boolean) => (value ? "On" : "Off");
const differs = (a: unknown, b: unknown) => stableStringify(a) !== stableStringify(b);

/**
 * Tracks the unsaved settings draft by diffing the live settings against a
 * snapshot taken at the last save/reload. Kept free of Obsidian UI so the
 * dirty-state rules can be unit tested.
 */
export class PendingChanges {
    readonly pluginIds = new Set<string>();
    private capturedBaseline?: LazySettings;
    private fingerprintSource?: LazySettings;
    private fingerprint?: string;
    private readonly getSource: () => DraftSource | undefined;
    private immediateSaveQueue: Promise<void> = Promise.resolve();

    constructor(getSource: () => DraftSource | undefined) {
        this.getSource = getSource;
        this.captureBaseline();
    }

    /** The saved settings the draft is compared against. */
    private get baselineData(): LazySettings | undefined {
        return this.getSource()?.persisted ?? this.capturedBaseline;
    }

    private get baselineFingerprint(): string | undefined {
        const baseline = this.baselineData;
        if (!baseline) return undefined;
        if (baseline !== this.fingerprintSource) {
            this.fingerprintSource = baseline;
            this.fingerprint = stableStringify(baseline);
        }
        return this.fingerprint;
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

    /**
     * Lists every difference from the baseline in user-facing terms so the
     * draft can be reviewed before saving. Reverts mutate the live objects in
     * place because the settings service keeps references to them.
     */
    describeChanges(describer: ChangeDescriber): PendingChange[] {
        const data = this.getSource()?.data;
        const baseline = this.baselineData;
        if (!data || !baseline) return [];
        const profileId = this.getSource()!.currentProfileId;
        const current = data.profiles[profileId]?.settings;
        const saved = baseline.profiles[profileId]?.settings;
        const changes: PendingChange[] = [];
        if (current && saved) {
            changes.push(...this.describePluginChanges(current, saved, describer));
            changes.push(...describeDeviceSettings(current, saved));
        }
        changes.push(...describeRootSettings(data, baseline));
        changes.push(...describeProfiles(data, baseline, profileId));
        return changes;
    }

    private describePluginChanges(current: DeviceSettings, saved: DeviceSettings, describer: ChangeDescriber): PendingChange[] {
        return this.getChangedPluginIds().map((pluginId) => {
            const entry: PluginSettings | undefined = current.plugins[pluginId];
            const savedEntry: PluginSettings | undefined = saved.plugins[pluginId];
            const mode = entry?.mode ?? describer.fallbackMode(pluginId, current);
            const savedMode = savedEntry?.mode ?? describer.fallbackMode(pluginId, saved);
            const revert = () => {
                if (savedEntry) current.plugins[pluginId] = structuredClone(savedEntry);
                else delete current.plugins[pluginId];
            };
            const base = { group: "plugins" as const, label: describer.pluginName(pluginId), from: PluginModes[savedMode], revert };
            if (!entry) return { ...base, to: "Entry removed" };
            // Lazy options can change while the mode stays the same; say so instead of showing an identical pair.
            if (mode === savedMode) return { ...base, to: `${PluginModes[mode]} (options changed)` };
            return { ...base, to: PluginModes[mode] };
        });
    }

    /**
     * Takes the draft out of the live settings, which return to the saved values,
     * and returns it so it can be restored later. Undefined when there is no draft.
     */
    stashDraft(): DraftStash | undefined {
        const source = this.getSource();
        const baseline = this.baselineData;
        if (!source?.data || !baseline || !this.hasChanges) return undefined;
        const stash = { draft: structuredClone(source.data), base: structuredClone(baseline), currentProfileId: source.currentProfileId };
        // Edit in place: the settings service keeps references to these objects.
        applySavedChanges(source.data, stash.draft, stash.base);
        this.pluginIds.clear();
        return stash;
    }

    /** Lists what a stashed draft changes, for offering it back. */
    describeStash(stash: DraftStash, describer: ChangeDescriber): PendingChange[] {
        // A throwaway view over copies keeps the stash itself unchanged.
        const view = { data: structuredClone(stash.draft), currentProfileId: stash.currentProfileId, persisted: stash.base };
        return new PendingChanges(() => view).describeChanges(describer);
    }

    /**
     * Puts a stashed draft back by applying only what it changed relative to its saved
     * settings, so saves made in the meantime (e.g. a Community plugins toggle) are kept.
     */
    restoreDraft(stash: DraftStash) {
        const data = this.getSource()?.data;
        if (!data) return;
        applySavedChanges(data, stash.base, stash.draft);
    }

    markDirty() {
        // Dirty state is derived from the baseline diff, so just ensure the baseline exists.
        // Callers invoke this after mutating settings; never recapture here or the edit would compare against itself.
        this.ensureBaseline();
    }

    saveImmediately(change: ImmediateSettingsChange, save: (data: LazySettings) => Promise<void>): Promise<void> {
        const profileId = this.getSource()?.currentProfileId;
        const pendingSave = this.immediateSaveQueue.then(async () => {
            this.ensureBaseline();
            const data = this.getSource()?.data;
            const baseline = this.baselineData;
            if (!data || !baseline || !profileId) throw new Error("Settings must be loaded before saving changes.");
            // Build from saved data so an unrelated control never persists a staged mode or lazy rule.
            const saved = structuredClone(baseline);
            await change(saved, profileId);
            if (!differs(baseline, saved)) return;
            await save(saved);
            applySavedChanges(data, baseline, saved);
            this.capturedBaseline = saved;
        });
        this.immediateSaveQueue = pendingSave.catch(() => undefined);
        return pendingSave;
    }

    async waitForImmediateSaves(): Promise<void> {
        await this.immediateSaveQueue;
    }

    reset() {
        this.pluginIds.clear();
        // Re-baseline to the current (saved or reloaded) state so earlier edits no longer count as pending.
        this.captureBaseline();
    }

    private ensureBaseline() {
        if (this.baselineData === undefined) this.captureBaseline();
    }

    private captureBaseline() {
        const data = this.getSource()?.data;
        if (!data) return;
        // Deep clone so later in-memory edits cannot mutate the comparison source.
        this.capturedBaseline = structuredClone(data);
    }
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply only the committed fields, retaining live drafts and the service's object references. */
function applySavedChanges(current: object, before: object, after: object) {
    const live = current as Record<string, unknown>;
    const previous = before as Record<string, unknown>;
    const saved = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(saved)])) {
        if (!differs(previous[key], saved[key])) continue;
        if (!Object.hasOwn(saved, key)) delete live[key];
        else if (isSettingsRecord(live[key]) && isSettingsRecord(previous[key]) && isSettingsRecord(saved[key])) {
            applySavedChanges(live[key], previous[key], saved[key]);
        } else live[key] = structuredClone(saved[key]);
    }
}

function describeDeviceSettings(current: DeviceSettings, saved: DeviceSettings): PendingChange[] {
    const changes: PendingChange[] = [];
    if (current.defaultMode !== saved.defaultMode) {
        changes.push({
            group: "settings",
            label: "Default mode",
            from: PluginModes[saved.defaultMode],
            to: PluginModes[current.defaultMode],
            revert: () => (current.defaultMode = saved.defaultMode),
        });
    }
    if (current.pruneUninstalledEntries !== saved.pruneUninstalledEntries) {
        changes.push({
            group: "settings",
            label: "Auto-remove uninstalled entries",
            from: onOff(saved.pruneUninstalledEntries),
            to: onOff(current.pruneUninstalledEntries),
            revert: () => (current.pruneUninstalledEntries = saved.pruneUninstalledEntries),
        });
    }
    if (current.restoreDraftBehavior !== saved.restoreDraftBehavior) {
        changes.push({
            group: "settings",
            label: "Unsaved draft prompt",
            from: RESTORE_DRAFT_BEHAVIOR_LABELS[saved.restoreDraftBehavior],
            to: RESTORE_DRAFT_BEHAVIOR_LABELS[current.restoreDraftBehavior],
            revert: () => (current.restoreDraftBehavior = saved.restoreDraftBehavior),
        });
    }
    const currentRecord = current as unknown as Record<string, unknown>;
    const savedRecord = saved as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(currentRecord), ...Object.keys(savedRecord)]);
    for (const key of keys) {
        if (DESCRIBED_DEVICE_KEYS.has(key) || !differs(currentRecord[key], savedRecord[key])) continue;
        changes.push({
            group: "settings",
            label: DEVICE_KEY_LABELS[key] ?? key,
            from: "Saved",
            to: "Edited",
            revert: () => (currentRecord[key] = structuredClone(savedRecord[key])),
        });
    }
    return changes;
}

function describeRootSettings(data: LazySettings, baseline: LazySettings): PendingChange[] {
    const changes: PendingChange[] = [];
    if (data.showConsoleLog !== baseline.showConsoleLog) {
        changes.push({
            group: "settings",
            label: "Debug log output",
            from: onOff(baseline.showConsoleLog),
            to: onOff(data.showConsoleLog),
            revert: () => (data.showConsoleLog = baseline.showConsoleLog),
        });
    }
    const dataRecord = data as unknown as Record<string, unknown>;
    const baselineRecord = baseline as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(dataRecord), ...Object.keys(baselineRecord)]);
    for (const key of keys) {
        if (DESCRIBED_ROOT_KEYS.has(key) || !differs(dataRecord[key], baselineRecord[key])) continue;
        // Internal fields have no control to restore from, so report them without a revert.
        changes.push({ group: "settings", label: key, from: "Saved", to: "Edited" });
    }
    return changes;
}

/**
 * Profile edits are listed without reverts: creating, deleting and assigning
 * profiles depend on each other, so undoing one alone could leave a device
 * default pointing at a missing profile.
 */
function describeProfiles(data: LazySettings, baseline: LazySettings, currentProfileId: string): PendingChange[] {
    const changes: PendingChange[] = [];
    const nameIn = (settings: LazySettings, id: string) => settings.profiles[id]?.name ?? id;
    for (const [key, label] of [
        ["desktopProfileId", "Desktop default profile"],
        ["mobileProfileId", "Mobile default profile"],
    ] as const) {
        if (data[key] === baseline[key]) continue;
        changes.push({ group: "profiles", label, from: nameIn(baseline, baseline[key]), to: nameIn(data, data[key]) });
    }
    const ids = new Set([...Object.keys(data.profiles), ...Object.keys(baseline.profiles)]);
    for (const id of ids) {
        const profile = data.profiles[id];
        const savedProfile = baseline.profiles[id];
        if (!savedProfile) {
            changes.push({ group: "profiles", label: profile.name, to: "Created" });
            continue;
        }
        if (!profile) {
            changes.push({ group: "profiles", label: savedProfile.name, to: "Deleted" });
            continue;
        }
        if (profile.name !== savedProfile.name) {
            changes.push({ group: "profiles", label: "Profile name", from: savedProfile.name, to: profile.name });
        }
        // The active profile's settings are already itemized above.
        if (id !== currentProfileId && differs(profile.settings, savedProfile.settings)) {
            changes.push({ group: "profiles", label: profile.name, from: "Saved", to: "Settings edited" });
        }
    }
    return changes;
}
