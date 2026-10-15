import type { LogLevelDesc } from "loglevel";
import path from "node:path";
import type { ObsidianAPI, ReloadOptions } from "obsidian-e2e-toolkit";
import { fileURLToPath } from "url";
import { test } from "./fixtures";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const pluginUnderTestId = "on-demand-plugins";
const targetPluginId = "obsidian42-brat";
const excalidrawPluginId = "obsidian-excalidraw-plugin";

type TestVaultOptions = {
    enableBrowserConsoleLogging?: boolean;
    fresh?: boolean;
    logLevel?: LogLevelDesc;
};

export function resolveMyfilesPluginPath(pluginId: string): string {
    return path.resolve(repoRoot, "myfiles", pluginId);
}

export function useVaultPlugins(pluginPaths: readonly string[], options: TestVaultOptions = {}) {
    test.use({
        vaultOptions: {
            enableBrowserConsoleLogging: options.enableBrowserConsoleLogging ?? false,
            logLevel: options.logLevel ?? "info",
            fresh: options.fresh ?? true,
            // Reason: each test vault must own its settings files instead of writing through a shared plugin symlink.
            plugins: pluginPaths.map((pluginPath) => ({ path: pluginPath, symlink: false })),
        },
    });
}

export function useOnDemandPluginsWithTargets(targetPluginIds: string | readonly string[], options: TestVaultOptions = {}) {
    const pluginIds = Array.isArray(targetPluginIds) ? [...targetPluginIds] : [targetPluginIds];

    // Mental model: most E2E suites only vary by which bundled plugin is mounted next to
    // the on-demand plugin, so centralizing the vault shape keeps scenarios aligned.
    useVaultPlugins([repoRoot, ...pluginIds.map(resolveMyfilesPluginPath)], {
        enableBrowserConsoleLogging: true,
        ...options,
    });
}

export function useOnDemandPluginOnly(options: TestVaultOptions = {}) {
    // Reason: persistence tests should exercise the plugin under test without depending on unrelated downloaded fixtures.
    useVaultPlugins([repoRoot], options);
}

export function useOnDemandPlugins() {
    useOnDemandPluginsWithTargets(targetPluginId);
}

export function useOnDemandPluginsWithExcalidraw() {
    useOnDemandPluginsWithTargets(excalidrawPluginId);
}

/**
 * Runs an action that may request app:reload, such as applying a startup policy. The reload request is
 * recorded instead of performed, so the test keeps running on the same page. The interception is removed
 * when the action settles.
 */
export async function withReloadRecorded<T>(obsidian: ObsidianAPI, action: () => Promise<T>): Promise<T> {
    const reload = await obsidian.interceptReload();
    try {
        return await action();
    } finally {
        await reload.restore();
    }
}

/** Reload after a policy change, waiting only for the plugins this scenario expects at startup. */
export async function reloadWithLazyPlugins(obsidian: ObsidianAPI, expectLoaded: readonly string[], options: Omit<ReloadOptions, "expectLoaded"> = {}): Promise<void> {
    await obsidian.reload({ ...options, expectLoaded: [...expectLoaded] });
}

export async function triggerActiveLeafChange(obsidian: ObsidianAPI): Promise<void> {
    await obsidian.page.evaluate(() => {
        const workspace = app.workspace as unknown as {
            activeLeaf?: unknown;
            getActiveLeaf?: () => unknown;
            trigger: (event: string, leaf: unknown) => void;
        };
        const leaf = workspace.getActiveLeaf?.() ?? workspace.activeLeaf ?? null;
        workspace.trigger("active-leaf-change", leaf);
    });
}

async function readOnDemandStorageRecord(obsidian: ObsidianAPI, prefix: string): Promise<Record<string, unknown> | null> {
    return obsidian.page.evaluate((storagePrefix) => {
        const value: unknown = app.loadLocalStorage(`on-demand:${storagePrefix}`);
        return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    }, prefix);
}

export async function readOnDemandStorageValue(obsidian: ObsidianAPI, prefix: string, key: string): Promise<unknown> {
    const record = await readOnDemandStorageRecord(obsidian, prefix);
    return record?.[key] ?? null;
}

export { excalidrawPluginId, pluginUnderTestId, targetPluginId };
