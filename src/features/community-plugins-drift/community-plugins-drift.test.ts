import { PLUGIN_MODE } from "src/core/types";
import type { DriftInput } from "src/features/community-plugins-drift/community-plugins-drift";
import { computeDesiredCommunityPlugins, describeDrift, detectCommunityPluginsDrift } from "src/features/community-plugins-drift/community-plugins-drift";
import { describe, expect, it } from "vitest";

const SELF = "on-demand-plugins";

function pluginIds(count: number, prefix = "plugin") {
    return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
}

/** Deterministic PRNG so the random rewrite is reproducible. */
function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function input(overrides: Partial<DriftInput> & Pick<DriftInput, "installed">): DriftInput {
    const desired = overrides.desired ?? new Set([SELF]);
    return { onDisk: desired, desired, known: desired, selfId: SELF, ...overrides };
}

describe("computeDesiredCommunityPlugins", () => {
    it("lists always-enabled plugins and itself, sorted", () => {
        const modes: Record<string, PLUGIN_MODE> = {
            zeta: PLUGIN_MODE.ALWAYS_ENABLED,
            alpha: PLUGIN_MODE.ALWAYS_ENABLED,
            lazy: PLUGIN_MODE.LAZY,
            ready: PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
            off: PLUGIN_MODE.ALWAYS_DISABLED,
        };
        expect(computeDesiredCommunityPlugins(Object.keys(modes), (id) => modes[id], SELF)).toEqual(["alpha", SELF, "zeta"]);
    });

    it("keeps on-disk entries for plugins this device does not manage", () => {
        const modes: Record<string, PLUGIN_MODE> = { alpha: PLUGIN_MODE.ALWAYS_ENABLED, lazy: PLUGIN_MODE.LAZY };
        const onDisk = ["lazy", "desktop-only", "not-installed-here", SELF];
        expect(computeDesiredCommunityPlugins(Object.keys(modes), (id) => modes[id], SELF, onDisk)).toEqual(["alpha", "desktop-only", "not-installed-here", SELF]);
    });

    it("never lists itself twice", () => {
        expect(computeDesiredCommunityPlugins([SELF], () => PLUGIN_MODE.ALWAYS_ENABLED, SELF)).toEqual([SELF]);
    });
});

describe("detectCommunityPluginsDrift", () => {
    const installed = ["alpha", "beta", "gamma"];

    it("reports nothing when the file matches what On-Demand wrote", () => {
        const desired = new Set(["alpha", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set(["alpha", SELF]) }))).toBeNull();
    });

    it("ignores Obsidian's startup rewrite, which keeps the content but may reorder it", () => {
        const desired = new Set(["alpha", "beta", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set([SELF, "beta", "alpha"]) }))).toBeNull();
    });

    it("ignores a toggle the settings already follow (Community plugins tab or CLI on an always-* plugin)", () => {
        // `obsidian plugin:enable id=beta` → enablePluginAndSave → the patch switched beta to always enabled.
        const known = new Set(["alpha", SELF]);
        const desired = new Set(["alpha", "beta", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, known, desired, onDisk: new Set(["alpha", "beta", SELF]) }))).toBeNull();
    });

    it("reports a lazy plugin enabled through the Community plugins tab or the CLI", () => {
        // The patch keeps lazy modes, so the file now loads beta eagerly while the settings still say lazy.
        const desired = new Set(["alpha", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set(["alpha", "beta", SELF]) }))).toEqual({
            enabledExternally: ["beta"],
            disabledExternally: [],
            selfMissing: false,
        });
    });

    it("does not report staged mode changes that the external edit did not touch", () => {
        // The user staged alpha → lazy and gamma → always enabled; the file still holds the old state.
        const known = new Set(["alpha", SELF]);
        const desired = new Set(["gamma", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, known, desired, onDisk: new Set(["alpha", SELF]) }))).toBeNull();
    });

    it("does not report an external edit that matches a staged change", () => {
        const known = new Set(["alpha", SELF]);
        const desired = new Set(["alpha", "beta", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, known, desired, onDisk: new Set(["alpha", "beta", SELF]) }))).toBeNull();
    });

    it("reports a missing On-Demand entry separately even when nothing else changed", () => {
        const desired = new Set(["alpha", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set(["alpha"]) }))).toEqual({
            enabledExternally: [],
            disabledExternally: [],
            selfMissing: true,
        });
    });

    it("ignores IDs of plugins that are not installed on this device", () => {
        const desired = new Set(["alpha", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set(["alpha", "other-device-only", SELF]) }))).toBeNull();
    });

    it("treats an emptied file (e.g. a Sync wipe) as every plugin disabled", () => {
        const desired = new Set(["alpha", "gamma", SELF]);
        expect(detectCommunityPluginsDrift(input({ installed, desired, onDisk: new Set() }))).toEqual({
            enabledExternally: [],
            disabledExternally: ["alpha", "gamma"],
            selfMissing: true,
        });
    });

    describe("bulk rewrites", () => {
        const many = pluginIds(60);

        it("reports dozens of plugins enabled at once", () => {
            const desired = new Set([SELF]);
            const enabled = many.slice(0, 40);
            const drift = detectCommunityPluginsDrift(input({ installed: many, desired, onDisk: new Set([SELF, ...enabled]) }));
            expect(drift?.enabledExternally).toEqual(enabled);
            expect(drift?.disabledExternally).toEqual([]);
            expect(drift?.selfMissing).toBe(false);
        });

        it("reports dozens of plugins disabled at once", () => {
            const desired = new Set([SELF, ...many]);
            const kept = many.slice(40);
            const drift = detectCommunityPluginsDrift(input({ installed: many, desired, onDisk: new Set([SELF, ...kept]) }));
            expect(drift?.enabledExternally).toEqual([]);
            expect(drift?.disabledExternally).toEqual(many.slice(0, 40));
        });

        it("reports exactly the externally flipped entries of an arbitrary rewrite", () => {
            const random = mulberry32(42);
            const known = new Set([SELF, ...many.filter(() => random() < 0.5)]);
            // A third of the plugins also carry a staged change in the draft.
            const desired = new Set(known);
            const staged = many.filter(() => random() < 0.33);
            for (const id of staged) {
                if (desired.has(id)) desired.delete(id);
                else desired.add(id);
            }
            const onDisk = new Set([SELF, ...many.filter(() => random() < 0.5)]);

            const drift = detectCommunityPluginsDrift(input({ installed: many, known, desired, onDisk }));

            const changedOutside = many.filter((id) => onDisk.has(id) !== known.has(id));
            const overwritten = changedOutside.filter((id) => onDisk.has(id) !== desired.has(id));
            expect(overwritten.length).toBeGreaterThan(5);
            expect(drift?.enabledExternally).toEqual(overwritten.filter((id) => onDisk.has(id)));
            expect(drift?.disabledExternally).toEqual(overwritten.filter((id) => !onDisk.has(id)));
            // Entries the user staged and the external edit left alone are never reported.
            const untouchedStaged = staged.filter((id) => onDisk.has(id) === known.has(id));
            const reported = new Set([...drift!.enabledExternally, ...drift!.disabledExternally]);
            expect(untouchedStaged.some((id) => reported.has(id))).toBe(false);
        });

        it("reports a full inversion of every entry", () => {
            const enabled = many.filter((_, i) => i % 2 === 0);
            const desired = new Set([SELF, ...enabled]);
            const onDisk = new Set([SELF, ...many.filter((id) => !desired.has(id))]);
            const drift = detectCommunityPluginsDrift(input({ installed: many, desired, onDisk }));
            expect(drift?.enabledExternally).toHaveLength(30);
            expect(drift?.disabledExternally).toEqual(enabled);
        });
    });
});

describe("describeDrift", () => {
    const nameOf = (id: string) => id.toUpperCase();

    it("names a few plugins and counts the rest", () => {
        const text = describeDrift({ enabledExternally: pluginIds(42), disabledExternally: ["x"], selfMissing: true }, nameOf);
        expect(text).toBe("community-plugins.json was changed outside On-Demand Plugins: enabled 42 (PLUGIN-00, PLUGIN-01, PLUGIN-02, +39 more); disabled 1 (X); removed On-Demand Plugins itself.");
    });

    it("omits empty sections", () => {
        expect(describeDrift({ enabledExternally: [], disabledExternally: ["a", "b"], selfMissing: false }, nameOf)).toBe("community-plugins.json was changed outside On-Demand Plugins: disabled 2 (A, B).");
    });
});
