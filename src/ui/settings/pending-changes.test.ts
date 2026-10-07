import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type { LazySettings } from "src/core/types";
import { PendingChanges } from "src/ui/settings/pending-changes";
import { describe, expect, it } from "vitest";

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

    it("falls back to staged plugin IDs before settings are loaded", () => {
        const pending = new PendingChanges(() => undefined);
        expect(pending.hasChanges).toBe(false);
        pending.pluginIds.add("foo");
        expect(pending.hasChanges).toBe(true);
        expect(pending.getChangedPluginIds()).toEqual(["foo"]);
    });
});
