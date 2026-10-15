import { DEFAULT_DEVICE_SETTINGS, INITIAL_BACKUP_PROFILE_ID, PLUGIN_MODE, SETTINGS_SCHEMA_VERSION } from "src/core/types";
import type { DeviceSettings, LazySettings, PLUGIN_MODE as PluginMode } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { overridesPlugin, resolveEffectiveSettings } from "src/services/settings/settings-layers";
import { SettingsService } from "src/services/settings/settings-service";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/storage");

function createService(loadedData: unknown) {
    const plugin = { loadData: vi.fn(async () => structuredClone(loadedData)), saveData: vi.fn().mockResolvedValue(undefined), app: { workspace: { trigger: vi.fn() } } };
    return { service: new SettingsService(plugin as unknown as OnDemandPlugin), plugin };
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MODES = Object.values(PLUGIN_MODE) as PluginMode[];

/** A version 1 profile with any mix of set and unset values, as older builds and hand edits produce. */
function randomV1Settings(random: () => number): Record<string, unknown> {
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
    const settings: Record<string, unknown> = {};
    if (random() < 0.7) settings.defaultMode = pick(MODES);
    if (random() < 0.7) settings.pruneUninstalledEntries = random() < 0.5;
    if (random() < 0.2) settings.showDescriptions = true; // removed setting older builds wrote
    const ids = Array.from({ length: 12 }, (_, i) => `plugin-${i}`);
    if (random() < 0.9) {
        const plugins: Record<string, unknown> = {};
        for (const id of ids) {
            if (random() < 0.5) continue;
            const entry: Record<string, unknown> = {};
            if (random() < 0.8) entry.mode = pick(MODES);
            if (random() < 0.5) entry.userConfigured = random() < 0.5;
            if (random() < 0.3) entry.lazyOptions = { useView: random() < 0.5, viewTypes: random() < 0.5 ? ["view-a"] : [], useFile: false, fileCriteria: {} };
            plugins[id] = entry;
        }
        settings.plugins = plugins;
    }
    if (random() < 0.6) settings.lazyOnViews = Object.fromEntries(ids.filter(() => random() < 0.2).map((id) => [id, random() < 0.5 ? [] : [`${id}-view`]]));
    if (random() < 0.6) settings.lazyOnFiles = Object.fromEntries(ids.filter(() => random() < 0.15).map((id) => [id, { suffixes: [".md"] }]));
    return settings;
}

/** How version 1 loading normalized a profile: missing values got built-in defaults. */
function v1Effective(raw: Record<string, unknown>): DeviceSettings {
    const settings = structuredClone(raw);
    delete settings.showDescriptions;
    return {
        defaultMode: (settings.defaultMode as PluginMode | undefined) ?? DEFAULT_DEVICE_SETTINGS.defaultMode,
        pruneUninstalledEntries: (settings.pruneUninstalledEntries as boolean | undefined) ?? DEFAULT_DEVICE_SETTINGS.pruneUninstalledEntries,
        plugins: (settings.plugins as DeviceSettings["plugins"] | undefined) ?? {},
        lazyOnViews: (settings.lazyOnViews as DeviceSettings["lazyOnViews"] | undefined) ?? {},
        lazyOnFiles: (settings.lazyOnFiles as DeviceSettings["lazyOnFiles"] | undefined) ?? {},
    };
}

function randomV1Data(seed: number) {
    const random = mulberry32(seed);
    const profileIds = ["Default", "Work", "Mobile", INITIAL_BACKUP_PROFILE_ID].filter((id, index) => index === 0 || random() < 0.7);
    const profiles = Object.fromEntries(profileIds.map((id) => [id, { id, name: id, settings: randomV1Settings(random) }]));
    return {
        settingsSchemaVersion: random() < 0.5 ? 1 : undefined,
        showConsoleLog: false,
        profiles,
        desktopProfileId: "Default",
        mobileProfileId: profileIds[profileIds.length - 1],
    };
}

describe("migrating version 1 profiles to a Base with overrides", () => {
    it.each(Array.from({ length: 40 }, (_, i) => i + 1))("keeps every profile's effective settings identical (seed %i)", async (seed) => {
        const before = randomV1Data(seed);
        const { service } = createService(before);

        await service.load();

        for (const [id, profile] of Object.entries(before.profiles)) {
            expect(resolveEffectiveSettings(service.data.profiles[id], service.data.base)).toEqual(v1Effective(profile.settings));
        }
        // Every plugin a profile had settings for stays overridden there, so later Base edits do not reach it.
        for (const [id, profile] of Object.entries(before.profiles)) {
            const raw = profile.settings as { plugins?: object; lazyOnViews?: object; lazyOnFiles?: object };
            const configured = new Set([...Object.keys(raw.plugins ?? {}), ...Object.keys(raw.lazyOnViews ?? {}), ...Object.keys(raw.lazyOnFiles ?? {})]);
            for (const pluginId of configured) expect(overridesPlugin(service.data.profiles[id].settings, pluginId)).toBe(true);
        }
    });

    it.each([3, 17, 29])("still matches after saving and loading the migrated data again (seed %i)", async (seed) => {
        const before = randomV1Data(seed);
        const first = createService(before);
        await first.service.load();
        await first.service.save();
        const saved = first.plugin.saveData.mock.calls[0][0] as LazySettings;
        expect(saved.settingsSchemaVersion).toBe(SETTINGS_SCHEMA_VERSION);

        const second = createService(saved);
        await second.service.load();

        for (const [id, profile] of Object.entries(before.profiles)) {
            expect(resolveEffectiveSettings(second.service.data.profiles[id], second.service.data.base)).toEqual(v1Effective(profile.settings));
        }
    });

    it("starts the Base from the built-in defaults and marks the install-time backup as a snapshot", async () => {
        const { service } = createService(randomV1Data(5));
        await service.load();
        expect(service.data.base).toEqual(DEFAULT_DEVICE_SETTINGS);
        for (const profile of Object.values(service.data.profiles)) {
            expect(profile.snapshot === true).toBe(profile.id === INITIAL_BACKUP_PROFILE_ID);
        }
    });

    it("leaves the values a version 2 profile does not set unset, so they come from the Base", async () => {
        const defaults = { ...structuredClone(DEFAULT_DEVICE_SETTINGS), defaultMode: PLUGIN_MODE.LAZY, plugins: { shared: { mode: PLUGIN_MODE.ALWAYS_ENABLED } } };
        const { service } = createService({
            settingsSchemaVersion: 2,
            showConsoleLog: false,
            base: defaults,
            profiles: { Default: { id: "Default", name: "Default", settings: { plugins: { own: { mode: PLUGIN_MODE.LAZY } } } } },
            desktopProfileId: "Default",
            mobileProfileId: "Default",
        });

        await service.load();

        const profile = service.data.profiles.Default;
        expect(profile.settings.defaultMode).toBeUndefined();
        expect(service.settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(service.settings.plugins).toEqual({ shared: { mode: PLUGIN_MODE.ALWAYS_ENABLED }, own: { mode: PLUGIN_MODE.LAZY } });
    });

    it("refuses settings from a newer format instead of overwriting them", async () => {
        const { service } = createService({ ...randomV1Data(1), settingsSchemaVersion: SETTINGS_SCHEMA_VERSION + 1 });
        await expect(service.load()).rejects.toThrow("newer or unsupported format");
    });

    it("refuses version 2 settings whose Base is missing", async () => {
        const { service } = createService({ ...randomV1Data(1), settingsSchemaVersion: 2 });
        await expect(service.load()).rejects.toThrow("Base settings in data.json are missing or damaged");
    });
});
