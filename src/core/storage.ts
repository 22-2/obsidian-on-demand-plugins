/**
 * Vault-scoped JSON persistence using store2.
 * Unchanged from original — just moved to core/.
 */
import store from "store2";

function getVaultId(app: any): string {
    if (!app) throw new Error("App/Plugin is required");
    // Try common locations for an identifier on App or Plugin objects
    if (app.appId) return app.appId;
    if (app.app && app.app.appId) return app.app.appId;
    if (app.manifest && app.manifest.id) return app.manifest.id;
    throw new Error("invalid App/Plugin ID");
}

export function vaultKey(app: any, prefix: string) {
    const appId = getVaultId(app);
    return `on-demand:${prefix}:${appId}`;
}

export function loadJSON<T = unknown>(app: any, prefix: string): T | undefined {
    try {
        const key = vaultKey(app, prefix);
        return store.get(key) as T | undefined;
    } catch (e) {
        return undefined;
    }
}

export function saveJSON<T = unknown>(app: any, prefix: string, value: T) {
    try {
        const key = vaultKey(app, prefix);
        store.set(key, value);
    } catch (e) {
        // ignore storage errors
    }
}
