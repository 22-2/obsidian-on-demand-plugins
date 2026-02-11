/**
 * activation-rules.ts — Centralised resolution of lazy-loading activation rules.
 *
 * Both ViewLazyLoader and FileLazyLoader query this module to decide which
 * plugin should handle a given view type or file, removing duplicated rule
 * look-ups and hard-coded special cases.
 */
import { TFile } from "obsidian";
import { PluginContext } from "../../../core/plugin-context";
import { FileActivationCriteria } from "../../../core/types";
import log from "loglevel";
import { isLazyMode } from "src/utils/utils";

const logger = log.getLogger("OnDemandPlugin/ActivationRules");

/** Built-in file rules that are always active unless overridden. */
const DEFAULT_FILE_RULES: Record<string, FileActivationCriteria> = {
    "obsidian-excalidraw-plugin": {
        suffixes: [".excalidraw"],
        frontmatterKeys: ["excalidraw-plugin"],
    },
    "lineage": {
        suffixes: [".lineage", ".ginko"],
    }
};

// ---------------------------------------------------------------------------
// View-type resolution
// ---------------------------------------------------------------------------

/**
 * Find the plugin that should be lazy-loaded for the given `viewType`.
 *
 * This function checks both the modern per-plugin lazyOptions and the legacy
 * global lazyOnViews map. It returns `null` when:
 * - No plugin claims this view type
 * - The matching plugin also has file-based rules (to prevent infinite rebuild loops)
 * - The plugin is not in a lazy mode
 *
 * @param ctx - The plugin context containing settings and app instance
 * @param viewType - The view type to resolve (e.g., "markdown", "canvas")
 * @returns The plugin ID that should handle this view type, or null
 */
export function resolvePluginForViewType(
    ctx: PluginContext,
    viewType: string,
): string | null {
    const settings = ctx.getSettings();

    // 1. Per-plugin lazyOptions (preferred)
    for (const [pluginId, pluginSettings] of Object.entries(settings.plugins)) {
        const opts = pluginSettings.lazyOptions;
        if (!opts?.useView || !opts.viewTypes.includes(viewType)) continue;

        // Defer to FileLazyLoader when file rules are also present
        if (hasFileRules(ctx, pluginId)) {
            logger.debug(`[LazyPlugins] resolvePluginForViewType: ${pluginId} has view rule for ${viewType} but also has file rules. Skipping.`);
            continue;
        }

        if (!isLazyMode(ctx.getPluginMode(pluginId))) continue;
        logger.debug(`[LazyPlugins] resolvePluginForViewType: resolved ${pluginId} for ${viewType}`);
        return pluginId;
    }

    // 2. Legacy global lazyOnViews map
    const lazyOnViews = settings.lazyOnViews || {};
    for (const [pluginId, viewTypes] of Object.entries(lazyOnViews)) {
        if (!viewTypes.includes(viewType)) continue;
        if (hasFileRules(ctx, pluginId)) continue;
        if (!isLazyMode(ctx.getPluginMode(pluginId))) continue;
        logger.debug(`[LazyPlugins] resolvePluginForViewType (legacy): resolved ${pluginId} for ${viewType}`);
        return pluginId;
    }

    return null;
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/**
 * Find the plugin that should be lazy-loaded for the given `file`.
 *
 * This function checks both the modern per-plugin lazyOptions and the legacy
 * global lazyOnFiles map (plus built-in defaults). It evaluates file criteria
 * such as suffixes, frontmatter keys, and content patterns.
 *
 * @param ctx - The plugin context containing settings and app instance
 * @param file - The file to check against activation criteria
 * @returns The plugin ID that should handle this file, or null
 */
export async function resolvePluginForFile(
    ctx: PluginContext,
    file: TFile,
): Promise<string | null> {
    const settings = ctx.getSettings();

    // 1. Per-plugin lazyOptions (preferred)
    for (const [pluginId, pluginSettings] of Object.entries(settings.plugins)) {
        if (!isLazyMode(ctx.getPluginMode(pluginId))) continue;

        const opts = pluginSettings.lazyOptions;
        if (opts?.useFile && (await matchesCriteria(ctx, file, opts.fileCriteria))) {
            logger.debug(`[LazyPlugins] resolvePluginForFile: resolved ${pluginId} for ${file.path}`);
            return pluginId;
        }
    }

    // 2. Legacy global lazyOnFiles + built-in defaults
    const lazyOnFiles = settings.lazyOnFiles || {};
    const allRules = { ...DEFAULT_FILE_RULES, ...lazyOnFiles };

    for (const [pluginId, criteria] of Object.entries(allRules)) {
        if (!isLazyMode(ctx.getPluginMode(pluginId))) continue;

        if (await matchesCriteria(ctx, file, criteria)) {
            logger.debug(`[LazyPlugins] resolvePluginForFile (legacy/default): resolved ${pluginId} for ${file.path}`);
            return pluginId;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Criteria matching
// ---------------------------------------------------------------------------

/**
 * Checks if a file matches the given activation criteria.
 *
 * Criteria can include:
 * - Suffixes: File basename must end with one of the specified suffixes
 * - Frontmatter keys: File must have one of the specified keys in its frontmatter
 * - Content patterns: File content must match one of the specified regex patterns
 *
 * @param ctx - The plugin context containing the app instance
 * @param file - The file to check
 * @param criteria - The activation criteria to match against
 * @returns True if the file matches any of the criteria
 */
export async function matchesCriteria(
    ctx: PluginContext,
    file: TFile,
    criteria: FileActivationCriteria,
): Promise<boolean> {
    const { app } = ctx;

    // 1. Suffix check (e.g. "foo.excalidraw" for "foo.excalidraw.md")
    if (criteria.suffixes?.length) {
        for (const suffix of criteria.suffixes) {
            if (file.basename.endsWith(suffix)) return true;
        }
    }

    // 2. Frontmatter key check
    if (criteria.frontmatterKeys?.length) {
        const cache = app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) {
            for (const key of criteria.frontmatterKeys) {
                if (Object.prototype.hasOwnProperty.call(cache.frontmatter, key)) {
                    return true;
                }
            }
        }
    }

    // 3. Content pattern check (regex)
    if (criteria.contentPatterns?.length) {
        try {
            const content = await app.vault.cachedRead(file);
            for (const pattern of criteria.contentPatterns) {
                if (new RegExp(pattern).test(content)) return true;
            }
        } catch (e) {
            logger.debug(`matchesCriteria: error reading ${file.path}`, e);
        }
    }

    return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the plugin has any kind of file-based activation rule—
 * either via lazyOptions.useFile, legacy lazyOnFiles, or the built-in defaults.
 */
function hasFileRules(ctx: PluginContext, pluginId: string): boolean {
    const settings = ctx.getSettings();

    if (settings.plugins[pluginId]?.lazyOptions?.useFile) return true;

    const lazyOnFiles = settings.lazyOnFiles || {};
    if (lazyOnFiles[pluginId] && Object.keys(lazyOnFiles[pluginId]).length > 0) return true;

    if (pluginId in DEFAULT_FILE_RULES) return true;

    return false;
}
