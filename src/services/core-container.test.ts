import { PLUGIN_MODE } from "src/core/types";
import type { SettingsService } from "src/services/settings/settings-service";
import type OnDemandPlugin from "src/main";
import { CoreContainer } from "src/services/core-container";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSettingsService, patchEnableDisable } = vi.hoisted(() => ({
    createSettingsService: vi.fn(),
    patchEnableDisable: vi.fn(),
}));

vi.mock("src/services/settings/settings-service", () => ({
    SettingsService: class {
        constructor(plugin: OnDemandPlugin) {
            return createSettingsService(plugin) as SettingsService;
        }
    },
}));

vi.mock("src/patches/plugin-enable-disable", () => ({
    patchPluginEnableDisable: patchEnableDisable,
}));

function createContext(settingsService: unknown, version = "3.5.1") {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();
    const plugin = {
        manifest: { version },
        saveSettings,
    } as unknown as OnDemandPlugin;
    const ctx = {
        _plugin: plugin,
        saveSettings,
        app: {
            vault: {
                readConfigJson: vi.fn().mockResolvedValue(["enabled-plugin"]),
            },
        },
        obsidianPlugins: {
            manifests: {},
            enabledPlugins: new Set<string>(),
        },
        register,
    };
    createSettingsService.mockReturnValue(settingsService);
    return { ctx, saveSettings, register };
}

describe("CoreContainer initialization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("keeps the initial enabled-plugin backup in memory without saving missing synced settings", async () => {
        const settingsService = {
            isFirstLoad: true,
            data: { profiles: {} as Record<string, { settings: { plugins: Record<string, unknown> } }> },
        };
        const { ctx, saveSettings } = createContext(settingsService);
        const container = new CoreContainer(ctx as never);

        await container.initialize();

        expect(settingsService.data.profiles["initial-backup"].settings.plugins["enabled-plugin"]).toEqual({
            mode: PLUGIN_MODE.ALWAYS_ENABLED,
            userConfigured: true,
        });
        // A missing data.json can still be waiting for Sync, so initialization must not publish defaults.
        expect(saveSettings).not.toHaveBeenCalled();
        expect(patchEnableDisable).toHaveBeenCalledWith(ctx);
    });

    it("persists the version update for an existing settings file", async () => {
        const settingsService = {
            isFirstLoad: false,
            data: { lastLazyPluginVersion: "3.5.0", profiles: {} },
        };
        const { ctx, saveSettings } = createContext(settingsService, "3.5.1");
        const container = new CoreContainer(ctx as never);

        await container.initialize();

        expect(settingsService.data.lastLazyPluginVersion).toBe("3.5.1");
        expect(saveSettings).toHaveBeenCalledOnce();
    });
});
