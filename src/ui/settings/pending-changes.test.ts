import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE, PluginModes } from "src/core/types";
import type { LazySettings } from "src/core/types";
import type { ChangeDescriber } from "src/ui/settings/pending-changes";
import { PendingChanges } from "src/ui/settings/pending-changes";
import { describe, expect, it, vi } from "vitest";

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

    it("saves ordinary settings without persisting or reverting staged modes and lazy rules", async () => {
        const source = createSource();
        const settings = source.data.profiles[DEFAULT_PROFILE_ID].settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_DISABLED };
        const pending = new PendingChanges(() => source);
        settings.plugins.foo.mode = PLUGIN_MODE.LAZY;
        settings.lazyOnViews.foo = ["foo-view"];
        const save = vi.fn<(data: LazySettings) => Promise<void>>().mockResolvedValue(undefined);

        await pending.saveImmediately((data, id) => {
            data.profiles[id].settings.defaultMode = PLUGIN_MODE.LAZY_ON_LAYOUT_READY;
        }, save);

        const persisted = save.mock.calls[0][0].profiles[DEFAULT_PROFILE_ID].settings;
        expect(persisted.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        expect(persisted.lazyOnViews).toEqual({});
        expect(persisted.defaultMode).toBe(PLUGIN_MODE.LAZY_ON_LAYOUT_READY);
        expect(source.data.profiles[DEFAULT_PROFILE_ID].settings).toBe(settings);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.LAZY);
        expect(settings.lazyOnViews.foo).toEqual(["foo-view"]);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
        expect(pending.describeChanges(describer).map((change) => change.label)).toEqual(["Foo plugin", "View activation rules"]);
    });

    it("follows the saved settings when another code path saves them", () => {
        const source: { data: LazySettings; currentProfileId: string; persisted?: LazySettings } = createSource();
        source.persisted = structuredClone(source.data);
        const pending = new PendingChanges(() => source);
        const settings = source.data.profiles[DEFAULT_PROFILE_ID].settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);

        // A save outside the settings tab (e.g. Save & apply, a profile switch) persisted the live state.
        source.persisted = structuredClone(source.data);
        expect(pending.hasChanges).toBe(false);
        expect(pending.getChangedPluginIds()).toEqual([]);
    });

    it("builds immediate saves on the saved settings, keeping edits saved elsewhere", async () => {
        const source: { data: LazySettings; currentProfileId: string; persisted?: LazySettings } = createSource();
        source.persisted = structuredClone(source.data);
        const pending = new PendingChanges(() => source);
        // A captured view type was saved without the settings tab knowing about it.
        source.data.profiles[DEFAULT_PROFILE_ID].settings.lazyOnViews.foo = ["foo-view"];
        source.persisted = structuredClone(source.data);
        const save = vi.fn<(data: LazySettings) => Promise<void>>().mockResolvedValue(undefined);

        await pending.saveImmediately((data) => {
            data.showConsoleLog = true;
        }, save);

        expect(save.mock.calls[0][0].profiles[DEFAULT_PROFILE_ID].settings.lazyOnViews).toEqual({ foo: ["foo-view"] });
    });

    it("serializes rapid edits including a return to the original value", async () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        const persisted: LazySettings[] = [];
        const save = async (data: LazySettings) => {
            await Promise.resolve();
            persisted.push(structuredClone(data));
        };
        await Promise.all([
            pending.saveImmediately((data) => {
                data.showConsoleLog = true;
            }, save),
            pending.saveImmediately((data) => {
                data.profiles.Default.settings.defaultMode = PLUGIN_MODE.LAZY;
            }, save),
            pending.saveImmediately((data) => {
                data.showConsoleLog = false;
            }, save),
        ]);

        expect(persisted).toHaveLength(3);
        expect(persisted[1].showConsoleLog).toBe(true);
        expect(persisted[2].showConsoleLog).toBe(false);
        expect(persisted[2].profiles.Default.settings.defaultMode).toBe(PLUGIN_MODE.LAZY);
        expect(source.data).toEqual(persisted[2]);
        expect(pending.hasChanges).toBe(false);
    });

    it("keeps the saved baseline and live settings on failure, then permits another save", async () => {
        const source = createSource();
        const pending = new PendingChanges(() => source);
        source.data.profiles.Default.settings.plugins.foo = { mode: PLUGIN_MODE.LAZY };
        const save = vi.fn<(data: LazySettings) => Promise<void>>().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
        const change = (data: LazySettings) => {
            data.showConsoleLog = true;
        };

        await expect(pending.saveImmediately(change, save)).rejects.toThrow("disk full");
        expect(source.data.showConsoleLog).toBe(false);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
        await pending.saveImmediately(change, save);
        expect(source.data.showConsoleLog).toBe(true);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });

    it("duplicates saved profile settings and commits metadata while retaining the active draft", async () => {
        const source = createSource();
        const settings = source.data.profiles.Default.settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_DISABLED };
        const pending = new PendingChanges(() => source);
        settings.plugins.foo.mode = PLUGIN_MODE.LAZY;
        const save = vi.fn<(data: LazySettings) => Promise<void>>().mockResolvedValue(undefined);

        await pending.saveImmediately((data) => {
            data.profiles.copy = { id: "copy", name: "Copy", settings: structuredClone(data.profiles.Default.settings) };
            data.profiles.Default.name = "Renamed";
            data.mobileProfileId = "copy";
        }, save);

        expect(source.data.profiles.copy.settings.plugins.foo.mode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        expect(source.data.profiles.Default.settings).toBe(settings);
        expect(settings.plugins.foo.mode).toBe(PLUGIN_MODE.LAZY);
        expect(pending.describeChanges(describer).map((change) => change.group)).toEqual(["plugins"]);
        await pending.saveImmediately((data) => {
            data.mobileProfileId = "Default";
            delete data.profiles.copy;
        }, save);
        expect(source.data.profiles.copy).toBeUndefined();
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });

    it("commits cleanup deletions while preserving an installed plugin's staged mode", async () => {
        const source = createSource();
        const settings = source.data.profiles.Default.settings;
        settings.plugins.foo = { mode: PLUGIN_MODE.ALWAYS_DISABLED };
        settings.plugins.ghost = { mode: PLUGIN_MODE.LAZY };
        settings.lazyOnFiles.ghost = { suffixes: [".ghost"] };
        const pending = new PendingChanges(() => source);
        settings.plugins.foo.mode = PLUGIN_MODE.LAZY;
        await pending.saveImmediately(
            (data, id) => {
                const saved = data.profiles[id].settings;
                saved.pruneUninstalledEntries = true;
                delete saved.plugins.ghost;
                delete saved.lazyOnFiles.ghost;
            },
            async () => undefined,
        );
        expect(settings.plugins.ghost).toBeUndefined();
        expect(settings.lazyOnFiles.ghost).toBeUndefined();
        expect(settings.pruneUninstalledEntries).toBe(true);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });
});
