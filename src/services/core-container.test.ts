import { PLUGIN_MODE } from "src/core/types";
import type { SettingsHost, SettingsService } from "src/services/settings/settings-service";
import { CoreContainer } from "src/services/core-container";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSettingsService } = vi.hoisted(() => ({
    createSettingsService: vi.fn(),
}));

vi.mock("src/services/settings/settings-service", () => ({
    SettingsService: class {
        constructor(host: SettingsHost) {
            return createSettingsService(host) as SettingsService;
        }
    },
}));

function createContext(settingsService: unknown, version = "3.5.1") {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();
    const ctx = {
        manifest: { version },
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
        const container = new CoreContainer(ctx as never, {} as SettingsHost);

        await container.initialize();

        expect(settingsService.data.profiles["initial-backup"].settings.plugins["enabled-plugin"]).toEqual({
            mode: PLUGIN_MODE.ALWAYS_ENABLED,
            userConfigured: true,
        });
        // A missing data.json can still be waiting for Sync, so initialization must not publish defaults.
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it("persists the version update for an existing settings file", async () => {
        const settingsService = {
            isFirstLoad: false,
            data: { lastLazyPluginVersion: "3.5.0", profiles: {} },
        };
        const { ctx, saveSettings } = createContext(settingsService, "3.5.1");
        const container = new CoreContainer(ctx as never, {} as SettingsHost);

        await container.initialize();

        expect(settingsService.data.lastLazyPluginVersion).toBe("3.5.1");
        expect(saveSettings).toHaveBeenCalledOnce();
    });
});
