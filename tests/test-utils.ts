import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { LogLevelDesc } from "loglevel";
import { test } from "obsidian-e2e-toolkit";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const pluginUnderTestId = "on-demand-plugins";
const targetPluginId = "obsidian42-brat";
const excalidrawPluginId = "obsidian-excalidraw-plugin";
const defaultPollIntervalMs = 200;
const defaultPollTimeoutMs = 8_000;

type TestVaultOptions = {
    enableBrowserConsoleLogging?: boolean;
    fresh?: boolean;
    logLevel?: LogLevelDesc;
};

type ObsidianTestContext = {
    isPluginEnabled: (pluginId: string) => Promise<boolean>;
    page: Page;
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
            plugins: pluginPaths.map((pluginPath) => ({ path: pluginPath })),
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

export async function pollUntil(
    condition: () => Promise<boolean>,
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // Mental model: plugin enablement and view registration complete on async workspace
    // events, so tests should wait on observable state instead of copy-pasting spin loops.
    while (Date.now() < deadline) {
        if (await condition()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
}

export async function waitForPluginState(
    obsidian: ObsidianTestContext,
    pluginId: string,
    shouldBeEnabled: boolean,
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
): Promise<boolean> {
    return pollUntil(
        async () => (await obsidian.isPluginEnabled(pluginId)) === shouldBeEnabled,
        timeoutMs,
        intervalMs,
    );
}

export async function waitForPluginEnabled(
    obsidian: ObsidianTestContext,
    pluginId: string,
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
): Promise<boolean> {
    return waitForPluginState(obsidian, pluginId, true, timeoutMs, intervalMs);
}

export async function waitForPluginDisabled(
    obsidian: ObsidianTestContext,
    pluginId: string,
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
): Promise<boolean> {
    return waitForPluginState(obsidian, pluginId, false, timeoutMs, intervalMs);
}

export async function waitForViewType(
    obsidian: ObsidianTestContext,
    viewType: string,
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
): Promise<boolean> {
    return pollUntil(
        () =>
            obsidian.page.evaluate(
                (targetViewType) => app.workspace.getLeavesOfType(targetViewType).length > 0,
                viewType,
            ),
        timeoutMs,
        intervalMs,
    );
}

export async function triggerActiveLeafChange(obsidian: ObsidianTestContext): Promise<void> {
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
    obsidian: ObsidianTestContext,
    commandPrefix: string,
): Promise<string | null> {
    return obsidian.page.evaluate(
        (prefix) => Object.keys(app.commands.commands).find((commandId) => commandId.startsWith(prefix)) ?? null,
        commandPrefix,
    );
}

export async function findCommandByExactId(
    obsidian: ObsidianTestContext,
    commandId: string,
): Promise<string | null> {
    return obsidian.page.evaluate(
        (targetCommandId) =>
            Object.keys(app.commands.commands).find((registeredCommandId) => registeredCommandId === targetCommandId) ?? null,
        commandId,
    );
}

export async function readCommunityPlugins(obsidian: ObsidianTestContext): Promise<string[]> {
    return obsidian.page.evaluate(async () => {
        const vault = app.vault as unknown as {
            adapter: {
                read: (path: string) => Promise<string>;
            };
            configDir: string;
        };
        const raw = await vault.adapter.read(`${vault.configDir}/community-plugins.json`);
        return JSON.parse(raw) as string[];
    });
}

async function readOnDemandStorageRecord(
    obsidian: ObsidianTestContext,
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
    obsidian: ObsidianTestContext,
    prefix: string,
    key: string,
): Promise<unknown> {
    const record = await readOnDemandStorageRecord(obsidian, prefix);
    return record?.[key] ?? null;
}

export { repoRoot, pluginUnderTestId, targetPluginId, excalidrawPluginId };
