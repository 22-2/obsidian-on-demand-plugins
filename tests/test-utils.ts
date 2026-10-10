import type { LogLevelDesc } from "loglevel";
import fs from "node:fs";
import path from "node:path";
import { test, type ObsidianAPI } from "obsidian-e2e-toolkit";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const pluginUnderTestId = "on-demand-plugins";
const targetPluginId = "obsidian42-brat";
const excalidrawPluginId = "obsidian-excalidraw-plugin";
const defaultWaitTimeoutMs = 8_000;

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

export function useOnDemandPluginsWithTargets(
    targetPluginIds: string | readonly string[],
    options: TestVaultOptions = {},
) {
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

export function ensureBuilt() {
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!fs.existsSync(mainJsPath)) {
        test.skip(true, "main.js not found; run build before tests");
        return false;
    }
    return true;
}

// Reason: the toolkit waiters throw on timeout, but specs branch on a boolean outcome.
async function settles(wait: Promise<void>): Promise<boolean> {
    try {
        await wait;
        return true;
    } catch {
        return false;
    }
}

export function waitForPluginLoaded(
    obsidian: ObsidianAPI,
    pluginId: string,
    timeoutMs = defaultWaitTimeoutMs,
): Promise<boolean> {
    return settles(obsidian.waitForPluginLoaded(pluginId, timeoutMs));
}

export function waitForPluginUnloaded(
    obsidian: ObsidianAPI,
    pluginId: string,
    timeoutMs = defaultWaitTimeoutMs,
): Promise<boolean> {
    return settles(obsidian.waitForPluginUnloaded(pluginId, timeoutMs));
}

export function waitForViewType(
    obsidian: ObsidianAPI,
    viewType: string,
    timeoutMs = defaultWaitTimeoutMs,
): Promise<boolean> {
    return settles(obsidian.waitForViewType(viewType, timeoutMs));
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

export async function findCommandByPrefix(
    obsidian: ObsidianAPI,
    commandPrefix: string,
): Promise<string | null> {
    return obsidian.page.evaluate(
        (prefix) => Object.keys(app.commands.commands).find((commandId) => commandId.startsWith(prefix)) ?? null,
        commandPrefix,
    );
}

export async function findCommandByExactId(
    obsidian: ObsidianAPI,
    commandId: string,
): Promise<string | null> {
    return obsidian.page.evaluate(
        (targetCommandId) =>
            Object.keys(app.commands.commands).find((registeredCommandId) => registeredCommandId === targetCommandId) ?? null,
        commandId,
    );
}

export async function readCommunityPlugins(obsidian: ObsidianAPI): Promise<string[]> {
    const configDir = await obsidian.evaluateApp(() => app.vault.configDir);
    return JSON.parse(await obsidian.read(`${configDir}/community-plugins.json`)) as string[];
}

async function readOnDemandStorageRecord(
    obsidian: ObsidianAPI,
    prefix: string,
): Promise<Record<string, unknown> | null> {
    return obsidian.page.evaluate((storagePrefix) => {
        const appWithId = app as unknown as {
            app?: {
                appId?: string;
            };
            appId?: string;
            manifest?: {
                id?: string;
            };
        };
        const appId = appWithId.appId ?? appWithId.app?.appId ?? appWithId.manifest?.id ?? null;
        if (!appId) {
            return null;
        }

        const raw = window.localStorage.getItem(`on-demand:${storagePrefix}:${appId}`);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    }, prefix);
}

export async function readOnDemandStorageValue(
    obsidian: ObsidianAPI,
    prefix: string,
    key: string,
): Promise<unknown> {
    const record = await readOnDemandStorageRecord(obsidian, prefix);
    return record?.[key] ?? null;
}

export { excalidrawPluginId, pluginUnderTestId, targetPluginId };
