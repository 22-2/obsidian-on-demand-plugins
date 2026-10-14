import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE, PluginModes } from "src/core/types";
import type { LazySettings } from "src/core/types";
import type { ChangeDescriber } from "src/ui/settings/pending-changes";
import { PendingChanges } from "src/ui/settings/pending-changes";
import { describe, expect, it } from "vitest";

const describer: ChangeDescriber = {
    pluginName: (pluginId) => `${pluginId[0].toUpperCase()}${pluginId.slice(1)} plugin`,
    fallbackMode: (_pluginId, settings) => settings.defaultMode,
};

function createSource() {
    const data: LazySettings = structuredClone(DEFAULT_SETTINGS);
    data.profiles[DEFAULT_PROFILE_ID].settings.plugins = {};
    return { data, currentProfileId: DEFAULT_PROFILE_ID };
}

describe("PendingChanges", () => {
    it("reports no changes right after capturing the baseline", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        expect(pending.hasChanges).toBe(false);
        expect(pending.getChangedPluginIds()).toEqual([]);
    });

    it("detects edits and lists only plugins whose entry changed", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        source.data.profiles[DEFAULT_PROFILE_ID].settings.plugins.foo = { mode: PLUGIN_MODE.LAZY, userConfigured: true };
        pending.markDirty();
        expect(pending.hasChanges).toBe(true);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });

    it("treats an edit reverted to the baseline as clean", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        source.data.showConsoleLog = !source.data.showConsoleLog;
        expect(pending.hasChanges).toBe(true);
        source.data.showConsoleLog = !source.data.showConsoleLog;
        expect(pending.hasChanges).toBe(false);
    });

    it("re-baselines on reset", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        source.data.profiles[DEFAULT_PROFILE_ID].settings.plugins.foo = { mode: PLUGIN_MODE.LAZY, userConfigured: true };
        pending.pluginIds.add("foo");
        pending.reset();
        expect(pending.hasChanges).toBe(false);
        expect(pending.pluginIds.size).toBe(0);
    });

    it("describes plugin mode and setting changes from the saved values", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        const settings = source.data.profiles[DEFAULT_PROFILE_ID].settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY, userConfigured: true };
        settings.defaultMode = PLUGIN_MODE.LAZY;
        source.data.showConsoleLog = true;
        expect(pending.describeChanges(describer).map(({ group, label, from, to }) => ({ group, label, from, to }))).toEqual([
            { group: "plugins", label: "Foo plugin", from: PluginModes[PLUGIN_MODE.ALWAYS_DISABLED], to: PluginModes[PLUGIN_MODE.LAZY] },
            { group: "settings", label: "Default mode", from: PluginModes[PLUGIN_MODE.ALWAYS_DISABLED], to: PluginModes[PLUGIN_MODE.LAZY] },
            { group: "settings", label: "Debug log output", from: "Off", to: "On" },
        ]);
    });

    it("reverts a single change back to the baseline", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        const settings = source.data.profiles[DEFAULT_PROFILE_ID].settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY, userConfigured: true };
        settings.defaultMode = PLUGIN_MODE.LAZY;
        pending.describeChanges(describer)[0].revert?.();
        expect(settings.plugins.foo).toBeUndefined();
        expect(pending.describeChanges(describer).map((change) => change.label)).toEqual(["Default mode"]);
    });

    it("lists profile edits without offering a revert", () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        source.data.profiles.work = { id: "work", name: "Work", settings: structuredClone(source.data.profiles[DEFAULT_PROFILE_ID].settings) };
        source.data.mobileProfileId = "work";
        const changes = pending.describeChanges(describer);
        expect(changes.map(({ label, from, to }) => ({ label, from, to }))).toEqual([
            { label: "Mobile default profile", from: "Default", to: "Work" },
            { label: "Work", from: undefined, to: "Created" },
        ]);
        expect(changes.every((change) => change.revert === undefined)).toBe(true);
    });

    it("falls back to staged plugin IDs before settings are loaded", () => {
        const pending = new PendingChanges(() => undefined);
        expect(pending.hasChanges).toBe(false);
        pending.pluginIds.add("foo");
        expect(pending.hasChanges).toBe(true);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });
});
