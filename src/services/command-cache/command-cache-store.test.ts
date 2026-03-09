import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../core/plugin-context";
import * as storageMs from "../../core/storage";
import { CommandCacheStore } from "./command-cache-store";

vi.mock("../../core/storage");

describe("CommandCacheStore", () => {
    let store: CommandCacheStore;
    let mockCtx: any;

    beforeEach(() => {
        vi.resetAllMocks();

        mockCtx = {
            app: {},
            getManifests: vi.fn().mockReturnValue([
                { id: "test-plugin", version: "1.0.0" },
                { id: "other-plugin", version: "2.0.0" },
            ]),
        };

        store = new CommandCacheStore(mockCtx as unknown as PluginContext);
    });

    describe("set and get", () => {
        it("should store commands and retrieve them", () => {
            const commands = [
                { id: "cmd1", name: "Cmd 1", icon: "", pluginId: "test-plugin" },
                { id: "cmd2", name: "Cmd 2", icon: "", pluginId: "test-plugin" },
            ];

            store.set("test-plugin", commands);

            expect(store.get("cmd1")).toEqual(commands[0]);
            expect(store.get("cmd2")).toEqual(commands[1]);
            expect(store.get("cmd3")).toBeUndefined();

            expect(store.has("test-plugin")).toBe(true);
            expect(store.has("other-plugin")).toBe(false);

            const ids = store.getIds("test-plugin");
            expect(ids).toBeDefined();
            expect(ids?.has("cmd1")).toBe(true);
            expect(ids?.has("cmd2")).toBe(true);
        });
    });

    describe("loadFromData", () => {
        it("should load cache from storage", () => {
            vi.mocked(storageMs.loadLocalStorage).mockReturnValue({
                "test-plugin": [{ id: "cmd1", name: "Cmd 1", icon: "icon1" }],
            });

            store.loadFromData();

            expect(storageMs.loadLocalStorage).toHaveBeenCalledWith(mockCtx.app, "commandCache");
            expect(store.has("test-plugin")).toBe(true);
            const cached = store.get("cmd1");
            expect(cached).toEqual({ id: "cmd1", name: "Cmd 1", icon: "icon1", pluginId: "test-plugin" });
        });

        it("should do nothing if storage is empty", () => {
            vi.mocked(storageMs.loadLocalStorage).mockReturnValue(null);

            store.set("existing", [{ id: "cmd", name: "cmd", icon: "", pluginId: "existing" }]);
            store.loadFromData();

            // Cache should not be cleared if no data is found (Wait, looking at the code, it returns early, so it preserves existing state)
            expect(store.has("existing")).toBe(true);
        });
    });

    describe("persist", () => {
        it("should save current cache to storage", async () => {
            store.set("test-plugin", [{ id: "cmd1", name: "Cmd 1", icon: "icon1", pluginId: "test-plugin" }]);

            await store.persist();

            expect(storageMs.saveLocalStorage).toHaveBeenCalledTimes(2);
            expect(storageMs.saveLocalStorage).toHaveBeenNthCalledWith(1, mockCtx.app, "commandCache", {
                "test-plugin": [{ id: "cmd1", name: "Cmd 1", icon: "icon1" }],
            });
            expect(storageMs.saveLocalStorage).toHaveBeenNthCalledWith(2, mockCtx.app, "commandCacheVersions", {
                "test-plugin": "1.0.0",
            });
        });
    });

    describe("isValid", () => {
        it("should return false if plugin has no index", () => {
            expect(store.isValid("test-plugin")).toBe(false);
        });

        it("should return false if cache has no data for plugin", () => {
            store.set("test-plugin", []); // empty
            vi.mocked(storageMs.loadLocalStorage).mockImplementation((app, key) => {
                if (key === "commandCache") return {};
                return null;
            });
            expect(store.isValid("test-plugin")).toBe(false);
        });

        it("should return false if version doesnt match", () => {
            store.set("test-plugin", [{ id: "cmd1", name: "", icon: "", pluginId: "test-plugin" }]);
            vi.mocked(storageMs.loadLocalStorage).mockImplementation((app, key) => {
                if (key === "commandCache") return { "test-plugin": [{ id: "cmd1" }] };
                if (key === "commandCacheVersions") return { "test-plugin": "0.9.0" }; // Different version
                return null;
            });
            expect(store.isValid("test-plugin")).toBe(false);
        });

        it("should return true if version matches", () => {
            store.set("test-plugin", [{ id: "cmd1", name: "", icon: "", pluginId: "test-plugin" }]);
            vi.mocked(storageMs.loadLocalStorage).mockImplementation((app, key) => {
                if (key === "commandCache") return { "test-plugin": [{ id: "cmd1" }] };
                if (key === "commandCacheVersions") return { "test-plugin": "1.0.0" }; // Matching version
                return null;
            });
            expect(store.isValid("test-plugin")).toBe(true);
        });
    });

    describe("clear", () => {
        it("should clear all data", () => {
            store.set("test-plugin", [{ id: "cmd1", name: "", icon: "", pluginId: "test-plugin" }]);
            expect(store.has("test-plugin")).toBe(true);

            store.clear();

            expect(store.has("test-plugin")).toBe(false);
            expect(store.get("cmd1")).toBeUndefined();
        });
    });
});
