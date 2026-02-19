/**
 * Vault-scoped JSON persistence using store2.
 * Unchanged from original — just moved to core/.
 */
import log from "loglevel";
import type { App } from "obsidian";
import "obsidian-typings";
import store from "store2";

const logger = log.getLogger("OnDemandPlugin/Storage");

function getVaultId(app: App): string {
    if (!app) throw new Error("App/Plugin is required");
    if (app.appId) return app.appId;
    throw new Error("invalid App/Plugin ID");
}

export function vaultKey(app: App, prefix: string) {
    const appId = getVaultId(app);
    return `on-demand:${prefix}:${appId}`;
}

export function loadJSON<T = unknown>(app: App, prefix: string): T | undefined {
    try {
        const key = vaultKey(app, prefix);
        return store.get(key) as T | undefined;
    } catch (e) {
        logger.error("Failed to load JSON from storage", e);
        return undefined;
    }
}

export function saveJSON<T = unknown>(app: App, prefix: string, value: T) {
    try {
        const key = vaultKey(app, prefix);
        store.set(key, value);
    } catch (e) {
        logger.error("Failed to save JSON to storage", e);
    }
}
