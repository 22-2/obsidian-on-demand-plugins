import type { App, DropdownComponent } from "obsidian";
import { FileSystemAdapter, Notice, Platform, normalizePath } from "obsidian";
import { openSystemPath } from "src/core/external-open";
import { PLUGIN_MODE, PluginModes } from "src/core/types";
import type { LazyOptions } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import type OnDemandPlugin from "src/main";

export type PluginStatistics = {
    alwaysEnabled: number;
    alwaysDisabled: number;
    lazy: number;
    lazyOnLayoutReady: number;
    total: number;
};

export function getPluginStatistics(plugin: OnDemandPlugin): PluginStatistics {
    const counts: PluginStatistics = { alwaysEnabled: 0, alwaysDisabled: 0, lazy: 0, lazyOnLayoutReady: 0, total: plugin.manifests.length };
    // Keep the four modes separate so each status indicator shows its own count.
    plugin.manifests.forEach(({ id }) => {
        const mode = plugin.getPluginMode(id);
        if (mode === PLUGIN_MODE.ALWAYS_ENABLED) counts.alwaysEnabled++;
        else if (mode === PLUGIN_MODE.ALWAYS_DISABLED) counts.alwaysDisabled++;
        else if (mode === PLUGIN_MODE.LAZY_ON_LAYOUT_READY) counts.lazyOnLayoutReady++;
        else counts.lazy++;
    });
    return counts;
}

export function pluginStatisticsText(plugin: OnDemandPlugin): string {
    const counts = getPluginStatistics(plugin);
    // Spaces and middots instead of bare slashes so the Setting name doesn't look cramped.
    return `⛔ ${counts.alwaysDisabled} · 🤲 ${counts.lazy} · 🚀 ${counts.lazyOnLayoutReady} · ✅ ${counts.alwaysEnabled}`;
}

export function pluginManagementSummary(plugin: OnDemandPlugin): string {
    const counts = getPluginStatistics(plugin);
    return `${counts.total} plugins`;
}

export function enabledBadgeText(app: App, pluginId: string, savedPluginIds?: ReadonlySet<string>): string {
    // Live runtime load is distinct from saved policy; only confirmed disk absence should be called in-memory only.
    if (!isPluginLoaded(app, pluginId)) return "Not loaded";
    return savedPluginIds && !savedPluginIds.has(pluginId) ? "Loaded (in memory only)" : "Loaded";
}

export function pluginModeLabel(mode: PLUGIN_MODE): string {
    // Keep the mode emoji as a quick visual cue while the fixed grid column
    // keeps each row's live state aligned.
    return PluginModes[mode];
}

export async function openPluginDirectory(app: App, manifest: { dir?: string; name: string }) {
    // Mirror openBackupDirectory: shell.openPath needs a desktop adapter and
    // an absolute path, so bail out early anywhere else.
    if (!Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
        new Notice("Revealing the plugin folder is available on desktop only.");
        return;
    }
    if (!manifest.dir) {
        new Notice(`Could not locate the folder for ${manifest.name}.`);
        return;
    }
    try {
        const error = await openSystemPath(`${app.vault.adapter.getBasePath()}/${manifest.dir}`);
        if (error) new Notice(`Could not open the plugin folder: ${error}`);
    } catch (error) {
        new Notice(`Could not open the plugin folder: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function openBackupDirectory(plugin: OnDemandPlugin) {
    if (!Platform.isDesktopApp || !(plugin.app.vault.adapter instanceof FileSystemAdapter)) {
        new Notice("Opening the backup folder is available on desktop only.");
        return;
    }

    const adapter = plugin.app.vault.adapter;
    const backupPath = normalizePath(`${plugin.manifest.dir}/backups`);
    try {
        if (!(await adapter.exists(backupPath))) await adapter.mkdir(backupPath);
        const error = await openSystemPath(`${adapter.getBasePath()}/${backupPath}`);
        if (error) new Notice(`Could not open the backup folder: ${error}`);
    } catch (error) {
        new Notice(`Could not open the backup folder: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Stages a mode change in the live settings draft. Returns false when nothing changed,
 * so callers can skip marking the draft dirty.
 */
export function stagePluginMode(plugin: OnDemandPlugin, pluginId: string, mode: PLUGIN_MODE): boolean {
    // Selecting the effective mode changes nothing semantically, so skip creating
    // an explicit entry just to flip userConfigured and keep the draft clean.
    const current = plugin.settings.plugins[pluginId];
    if (plugin.getPluginMode(pluginId) === mode && (current?.mode === undefined || current.mode === mode)) return false;
    // Changing the mode should preserve advanced lazy options so
    // users can temporarily disable a plugin without reconfiguring it.
    plugin.settings.plugins[pluginId] = { ...(current ?? {}), mode, userConfigured: true };
    return true;
}

/** The lazy options a plugin runs with now, including defaults for one that has none saved yet. */
export function currentLazyOptions(plugin: OnDemandPlugin, pluginId: string): LazyOptions {
    const settings = plugin.settings.plugins[pluginId];
    if (settings?.lazyOptions) return structuredClone(settings.lazyOptions);
    // Excalidraw files are recognised by their suffix and frontmatter, so it loads on file open by default.
    if (pluginId === "obsidian-excalidraw-plugin") {
        return { useView: false, viewTypes: [], useFile: true, fileCriteria: { suffixes: [".excalidraw"], frontmatterKeys: ["excalidraw-plugin"] } };
    }
    const legacyViewTypes = plugin.settings.lazyOnViews?.[pluginId] ?? [];
    return {
        // Legacy view rules are represented by LAZY + lazyOptions/useView.
        useView: settings?.mode === "lazy" && legacyViewTypes.length > 0,
        viewTypes: legacyViewTypes,
        useFile: false,
        fileCriteria: structuredClone(plugin.settings.lazyOnFiles?.[pluginId] ?? {}),
    };
}

/** Stages lazy options in the live settings draft. Returns false when they are unchanged. */
export function stageLazyOptions(plugin: OnDemandPlugin, pluginId: string, options: LazyOptions): boolean {
    if (JSON.stringify(options) === JSON.stringify(currentLazyOptions(plugin, pluginId))) return false;
    // Plugin settings are sparse until a mode is explicitly configured, but advanced options must still be saveable.
    const pluginSettings = (plugin.settings.plugins[pluginId] ??= { mode: plugin.getPluginMode(pluginId), userConfigured: false });
    pluginSettings.lazyOptions = structuredClone(options);
    // For backward compatibility during transition, also update the global maps
    setLegacyRule(plugin.settings.lazyOnViews, pluginId, options.useView ? options.viewTypes : []);
    setLegacyRule(plugin.settings.lazyOnFiles, pluginId, options.useFile ? options.fileCriteria : {});
    return true;
}

/**
 * A missing entry and an empty one mean the same rule, so an empty value is written only over a
 * non-empty one. Otherwise toggling an option would list an unchanged rule map in the review.
 */
function setLegacyRule<T extends object>(map: Record<string, T>, pluginId: string, value: T) {
    const isEmpty = (rule: T | undefined) => rule === undefined || Object.keys(rule).length === 0;
    if (isEmpty(value) && isEmpty(map[pluginId])) return;
    map[pluginId] = value;
}

export function addModeOptions(dropdown: DropdownComponent): DropdownComponent {
    for (const [mode, label] of Object.entries(PluginModes)) dropdown.addOption(mode, label);
    return dropdown;
}
