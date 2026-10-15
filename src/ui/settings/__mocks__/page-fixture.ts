import { vi } from "vitest";
import { DEFAULT_DEVICE_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type { LazySettings } from "src/core/types";
import type OnDemandPlugin from "src/main";
import type { SettingsTab } from "src/ui/settings-tab";
import type { ImmediateSettingsChange } from "src/ui/settings/pending-changes";

export function createPageFixture(feature?: unknown) {
    const profile = (id: string, name: string) => ({ id, name, settings: structuredClone(DEFAULT_DEVICE_SETTINGS) });
    const data: LazySettings = {
        showConsoleLog: false,
        restoreDraftBehavior: "ask",
        desktopProfileId: "home",
        mobileProfileId: "work",
        profiles: {
            home: profile("home", "Home"),
            work: profile("work", "Work"),
            spare: profile("spare", "Spare"),
            "initial-backup": profile("initial-backup", "Initial backup"),
        },
    };
    const service = { data, currentProfileId: "home" };
    const plugin = {
        data,
        core: { settingsService: service },
        app: { commands: { executeCommandById: vi.fn() } },
        features: { get: vi.fn().mockReturnValue(feature) },
        manifests: [
            { id: "alpha", name: "Alpha" },
            { id: "beta", name: "Beta" },
        ],
        getPluginMode: vi.fn((id: string) => (id === "alpha" ? PLUGIN_MODE.ALWAYS_DISABLED : PLUGIN_MODE.ALWAYS_ENABLED)),
        updateManifests: vi.fn(),
        configureLogger: vi.fn(),
        switchProfile: vi.fn(async (id: string) => {
            service.currentProfileId = id;
        }),
    };
    let createdCount = 0;
    const tab = {
        hasPendingChanges: false,
        pendingPluginIds: new Set<string>(),
        renderPendingControls: vi.fn((_container: unknown, _refresh: () => void) => undefined),
        markDirty: vi.fn(),
        resetPending: vi.fn(),
        waitForImmediateSaves: vi.fn().mockResolvedValue(undefined),
        discardPendingChanges: vi.fn().mockResolvedValue(undefined),
        offerRestoreOnPageOpen: vi.fn(),
        requestRestoreOnPageClose: vi.fn(),
        saveImmediateChanges: vi.fn(async (change: ImmediateSettingsChange) => {
            await change(data, service.currentProfileId);
        }),
        createProfile: vi.fn(async (name: string, source?: string) => {
            const id = `created-${++createdCount}`;
            data.profiles[id] = { id, name, settings: structuredClone(source ? data.profiles[source].settings : DEFAULT_DEVICE_SETTINGS) };
        }),
    };
    return { data, service, pluginMock: plugin, tabMock: tab, plugin: plugin as unknown as OnDemandPlugin, tab: tab as unknown as SettingsTab };
}
