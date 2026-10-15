import { PLUGIN_MODE } from "src/core/types";

/**
 * Plugins whose entry in community-plugins.json was changed by someone other
 * than On-Demand (Obsidian's own toggles, its CLI, another plugin, Sync, Git or
 * a manual edit) and that On-Demand's next write would undo.
 */
export type CommunityPluginsDrift = {
    /** Installed plugins the file enables although On-Demand would leave them out. */
    enabledExternally: string[];
    /** Plugins On-Demand keeps enabled but the file no longer lists. */
    disabledExternally: string[];
    /** On-Demand itself is missing, so Obsidian will not load it on the next start. */
    selfMissing: boolean;
};

export type DriftInput = {
    /** IDs currently listed in community-plugins.json. */
    onDisk: ReadonlySet<string>;
    /** IDs On-Demand would write now, from the live settings. */
    desired: ReadonlySet<string>;
    /** IDs On-Demand last expected in the file: what it derived at startup or last wrote. */
    known: ReadonlySet<string>;
    /** Installed plugin IDs On-Demand manages; others are left to Obsidian. */
    installed: Iterable<string>;
    selfId: string;
};

/**
 * IDs On-Demand writes to community-plugins.json: always-enabled plugins plus itself, sorted.
 * IDs in `onDisk` that this device does not manage (plugins not installed here, or desktop-only
 * plugins on mobile) are kept: the file is shared through Sync, and dropping them would disable
 * those plugins on the devices that have them.
 */
export function computeDesiredCommunityPlugins(manifestIds: Iterable<string>, getMode: (pluginId: string) => PLUGIN_MODE, selfId: string, onDisk: Iterable<string> = []): string[] {
    const managed = new Set(manifestIds);
    const ids = new Set<string>([selfId]);
    for (const id of managed) {
        if (getMode(id) === PLUGIN_MODE.ALWAYS_ENABLED) ids.add(id);
    }
    for (const id of onDisk) {
        if (!managed.has(id)) ids.add(id);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Compares the file by content rather than by write events: Obsidian rewrites it
 * unchanged on every start, and any plugin can write it. An entry counts only when
 * it differs from both what On-Demand expected and what it would write, so staged
 * mode changes and toggles the settings already follow are not reported.
 */
export function detectCommunityPluginsDrift({ onDisk, desired, known, installed, selfId }: DriftInput): CommunityPluginsDrift | null {
    const enabledExternally: string[] = [];
    const disabledExternally: string[] = [];
    for (const id of new Set(installed)) {
        if (id === selfId) continue;
        const listed = onDisk.has(id);
        if (listed === desired.has(id) || listed === known.has(id)) continue;
        (listed ? enabledExternally : disabledExternally).push(id);
    }
    const selfMissing = !onDisk.has(selfId);
    if (!selfMissing && enabledExternally.length === 0 && disabledExternally.length === 0) return null;
    return { enabledExternally: enabledExternally.sort(), disabledExternally: disabledExternally.sort(), selfMissing };
}

/** One-line summary; long lists are cut so a bulk change of dozens of plugins stays readable. */
export function describeDrift(drift: CommunityPluginsDrift, nameOf: (pluginId: string) => string, previewCount = 3): string {
    const preview = (ids: string[]) => {
        const names = ids.slice(0, previewCount).map(nameOf).join(", ");
        return ids.length > previewCount ? `${names}, +${ids.length - previewCount} more` : names;
    };
    const parts: string[] = [];
    if (drift.enabledExternally.length > 0) parts.push(`enabled ${drift.enabledExternally.length} (${preview(drift.enabledExternally)})`);
    if (drift.disabledExternally.length > 0) parts.push(`disabled ${drift.disabledExternally.length} (${preview(drift.disabledExternally)})`);
    if (drift.selfMissing) parts.push("removed On-Demand Plugins itself");
    return `community-plugins.json was changed outside On-Demand Plugins: ${parts.join("; ")}.`;
}
