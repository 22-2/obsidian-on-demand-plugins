import { Platform } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ON_DEMAND_PLUGIN_ID } from "src/core/constants";
import { PluginRegistry } from "src/services/registry/plugin-registry";

vi.mock("obsidian", () => ({
    normalizePath: (p: string) => p,
    Platform: { isMobile: false },
}));

describe("PluginRegistry", () => {
    let registry: PluginRegistry;
    let mockApp: any;
    let mockObsidianPlugins: any;

    beforeEach(() => {
        vi.resetAllMocks();

        mockApp = {
            vault: {
                configDir: ".obsidian",
                readConfigJson: vi.fn(),
                writeConfigJson: vi.fn(),
            },
        };

        mockObsidianPlugins = {
            manifests: {
                "plugin-a": { id: "plugin-a", name: "Alpha" },
                "plugin-b": { id: "plugin-b", name: "Beta" },
                [ON_DEMAND_PLUGIN_ID]: { id: ON_DEMAND_PLUGIN_ID, name: "Lazy" },
            },
            enabledPlugins: new Set(["plugin-a"]),
        };

        registry = new PluginRegistry(mockApp, mockObsidianPlugins);
    });

    describe("updateManifests", () => {
        it("should filter out lazy loader and sort by name", () => {
            registry.reloadManifests();
            expect(registry.manifests).toHaveLength(2);
            expect(registry.manifests[0].id).toBe("plugin-a");
            expect(registry.manifests[1].id).toBe("plugin-b");
        });

        it("should filter desktop-only on mobile", () => {
            vi.mocked(Platform).isMobile = true;
            mockObsidianPlugins.manifests["desktop-only"] = { id: "desktop-only", name: "Zebra", isDesktopOnly: true };

            registry.reloadManifests();

            expect(registry.manifests.find((p) => p.id === "desktop-only")).toBeUndefined();
            vi.mocked(Platform).isMobile = false;
        });
    });

    describe("loadEnabledPluginsFromDisk", () => {
        it("should load list from config json", async () => {
            mockApp.vault.readConfigJson.mockResolvedValue(["plugin-a", "plugin-c"]);

            await registry.loadEnabledPluginsFromDisk();

            expect(mockApp.vault.readConfigJson).toHaveBeenCalledWith("community-plugins");
            expect(registry.enabledPluginsFromDisk.has("plugin-a")).toBe(true);
            expect(registry.enabledPluginsFromDisk.has("plugin-c")).toBe(true);
        });

        it("should handle error gracefully", async () => {
            mockApp.vault.readConfigJson.mockRejectedValue(new Error("Disk Error"));

            await registry.loadEnabledPluginsFromDisk(true);

            expect(registry.enabledPluginsFromDisk.size).toBe(0);
        });
    });

    describe("isPluginEnabledOnDisk", () => {
        it("should check both memory and disk sets", () => {
            registry.enabledPluginsFromDisk.add("plugin-d");
            expect(registry.isPluginEnabledOnDisk("plugin-a")).toBe(true); // From memory
            expect(registry.isPluginEnabledOnDisk("plugin-d")).toBe(true); // From disk
            expect(registry.isPluginEnabledOnDisk("unknown")).toBe(false);
        });
    });

    describe("writeCommunityPluginsFile", () => {
        it("should use writeConfigJson", async () => {
            await registry.writeCommunityPluginsFile(["plugin-a"]);
            expect(mockApp.vault.writeConfigJson).toHaveBeenCalledWith("community-plugins", ["plugin-a"]);
        });
    });

    describe("clear", () => {
        it("should clear everything", () => {
            registry.reloadManifests();
            registry.enabledPluginsFromDisk.add("test");

            registry.clear();

            expect(registry.manifests).toHaveLength(0);
            expect(registry.enabledPluginsFromDisk.size).toBe(0);
        });
    });
});
