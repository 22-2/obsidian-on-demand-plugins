/**
 * Vault-scoped, device-local JSON persistence through Obsidian's
 * `App.loadLocalStorage` / `App.saveLocalStorage` (public since 1.8.7).
 */
import log from "loglevel";
import type { App } from "obsidian";

const logger = log.getLogger("OnDemandPlugin/Storage");

function storageKey(prefix: string) {
    return `on-demand:${prefix}`;
}

/** Key the store2-based storage of 3.7.x and earlier used; the vault id was part of the key itself. */
function legacyKey(app: App, prefix: string) {
    return `on-demand:${prefix}:${app.appId}`;
}

/**
 * Move a value written by the store2-based storage under the App API key, once.
 * Without this an update would drop the command cache and leave lazy plugins without commands.
 * TODO: remove once upgrades from 3.7.x and earlier no longer need supporting.
 */
function migrateLegacyValue(app: App, prefix: string): unknown {
    if (!app.appId || typeof window === "undefined" || !window.localStorage) return null;
    const key = legacyKey(app, prefix);
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    window.localStorage.removeItem(key);
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        logger.warn("Dropping unreadable legacy storage value", key);
        return null;
    }
    app.saveLocalStorage(storageKey(prefix), value);
    return value;
}

export function loadLocalStorage<T = unknown>(app: App, prefix: string): T | undefined {
    try {
        const value: unknown = app.loadLocalStorage(storageKey(prefix)) ?? migrateLegacyValue(app, prefix);
        return (value ?? undefined) as T | undefined;
    } catch (e) {
        logger.error("Failed to load JSON from storage", e);
        return undefined;
    }
}

export function saveLocalStorage<T = unknown>(app: App, prefix: string, value: T) {
    try {
        app.saveLocalStorage(storageKey(prefix), value ?? null);
    } catch (e) {
        logger.error("Failed to save JSON to storage", e);
    }
}
