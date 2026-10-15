import type { App } from "obsidian";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createLocalStorage() {
    const items = new Map<string, string>();
    return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
        items,
    };
}

function createApp() {
    const values = new Map<string, unknown>();
    return {
        appId: "vault-1",
        loadLocalStorage: vi.fn((key: string) => values.get(key) ?? null),
        saveLocalStorage: vi.fn((key: string, data: unknown) => {
            if (data === null) values.delete(key);
            else values.set(key, data);
        }),
        values,
    };
}

describe("storage", () => {
    let localStorage: ReturnType<typeof createLocalStorage>;
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
        localStorage = createLocalStorage();
        vi.stubGlobal("localStorage", localStorage);
        app = createApp();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("round-trips values through the App local storage API", () => {
        saveLocalStorage(app as unknown as App, "commandCache", { a: [] });

        expect(app.saveLocalStorage).toHaveBeenCalledWith("on-demand:commandCache", { a: [] });
        expect(loadLocalStorage(app as unknown as App, "commandCache")).toEqual({ a: [] });
    });

    it("returns undefined for a missing value", () => {
        expect(loadLocalStorage(app as unknown as App, "commandCache")).toBeUndefined();
    });

    it("moves a legacy store2 value under the new key once", () => {
        localStorage.setItem("on-demand:commandCache:vault-1", JSON.stringify({ p: [{ id: "p:cmd" }] }));

        expect(loadLocalStorage(app as unknown as App, "commandCache")).toEqual({ p: [{ id: "p:cmd" }] });
        expect(localStorage.items.has("on-demand:commandCache:vault-1")).toBe(false);
        expect(app.values.get("on-demand:commandCache")).toEqual({ p: [{ id: "p:cmd" }] });
    });

    it("ignores legacy values of other vaults", () => {
        localStorage.setItem("on-demand:commandCache:vault-2", JSON.stringify({ p: [] }));

        expect(loadLocalStorage(app as unknown as App, "commandCache")).toBeUndefined();
        expect(localStorage.items.has("on-demand:commandCache:vault-2")).toBe(true);
    });

    it("drops an unreadable legacy value", () => {
        localStorage.setItem("on-demand:compactList:vault-1", "{not json");

        expect(loadLocalStorage(app as unknown as App, "compactList")).toBeUndefined();
        expect(localStorage.items.has("on-demand:compactList:vault-1")).toBe(false);
    });
});
