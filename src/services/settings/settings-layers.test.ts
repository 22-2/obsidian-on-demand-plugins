import { DEFAULT_DEVICE_SETTINGS, PLUGIN_MODE } from "src/core/types";
import type { DeviceSettings, LazySettings, Profile } from "src/core/types";
import { inheritPlugin, layerProvidingPlugin, overridePlugin, overridesPlugin, pluginLayerToEdit, resolveDeviceValue, resolveEffectiveSettings } from "src/services/settings/settings-layers";
import { describe, expect, it } from "vitest";

const lazyOptions = { useView: true, viewTypes: ["shared-view"], useFile: false, fileCriteria: {} };

function defaults(): DeviceSettings {
    return {
        ...structuredClone(DEFAULT_DEVICE_SETTINGS),
        defaultMode: PLUGIN_MODE.LAZY,
        plugins: { shared: { mode: PLUGIN_MODE.LAZY, lazyOptions: structuredClone(lazyOptions) }, other: { mode: PLUGIN_MODE.ALWAYS_ENABLED } },
        lazyOnViews: { shared: ["shared-view"] },
    };
}

function profile(settings: Partial<Profile["settings"]> = {}, snapshot?: boolean): Profile {
    return { id: "p", name: "P", settings: { plugins: {}, lazyOnViews: {}, lazyOnFiles: {}, ...settings }, ...(snapshot ? { snapshot } : {}) };
}

describe("resolveEffectiveSettings", () => {
    it("inherits everything a profile does not override", () => {
        expect(resolveEffectiveSettings(profile(), defaults())).toEqual(defaults());
    });

    it("takes a profile-wide value and whole plugins from the profile when it overrides them", () => {
        const own = profile({ defaultMode: PLUGIN_MODE.ALWAYS_DISABLED, plugins: { shared: { mode: PLUGIN_MODE.ALWAYS_DISABLED } } });
        const effective = resolveEffectiveSettings(own, defaults());
        expect(effective.defaultMode).toBe(PLUGIN_MODE.ALWAYS_DISABLED);
        // The override replaces the whole unit: the inherited lazy options and view rules do not leak in.
        expect(effective.plugins.shared).toEqual({ mode: PLUGIN_MODE.ALWAYS_DISABLED });
        expect(effective.lazyOnViews.shared).toBeUndefined();
        expect(effective.plugins.other).toEqual({ mode: PLUGIN_MODE.ALWAYS_ENABLED });
    });

    it("treats a view or file rule alone as an override of the plugin", () => {
        const own = profile({ lazyOnViews: { shared: [] } });
        expect(overridesPlugin(own.settings, "shared")).toBe(true);
        expect(resolveEffectiveSettings(own, defaults()).plugins.shared).toBeUndefined();
    });

    it("ignores the Base for a snapshot profile", () => {
        const effective = resolveEffectiveSettings(profile({}, true), defaults());
        expect(effective).toEqual(DEFAULT_DEVICE_SETTINGS);
    });

    it("returns a copy, so editing it changes no layer", () => {
        const shared = defaults();
        const effective = resolveEffectiveSettings(profile(), shared);
        effective.plugins.shared.mode = PLUGIN_MODE.ALWAYS_DISABLED;
        expect(shared.plugins.shared.mode).toBe(PLUGIN_MODE.LAZY);
    });
});

describe("editing layers", () => {
    const data = (own: Profile): Pick<LazySettings, "base" | "profiles"> => ({ base: defaults(), profiles: { p: own } });

    it("starts an override from the inherited unit, so editing the mode keeps the lazy options", () => {
        const layers = data(profile());
        pluginLayerToEdit(layers, "p", "shared").plugins.shared.mode = PLUGIN_MODE.ALWAYS_ENABLED;
        expect(layers.profiles.p.settings.plugins.shared).toEqual({ mode: PLUGIN_MODE.ALWAYS_ENABLED, lazyOptions });
        expect(layers.profiles.p.settings.lazyOnViews.shared).toEqual(["shared-view"]);
        expect(layers.base.plugins.shared.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("marks an override even for a plugin with nothing to inherit", () => {
        const own = profile();
        overridePlugin(own, defaults(), "new");
        expect(own.settings.plugins.new).toEqual({});
        expect(overridesPlugin(own.settings, "new")).toBe(true);
    });

    it("inherits again once the override is dropped", () => {
        const own = profile({ plugins: { shared: { mode: PLUGIN_MODE.ALWAYS_DISABLED } }, lazyOnViews: { shared: [] } });
        inheritPlugin(own.settings, "shared");
        expect(overridesPlugin(own.settings, "shared")).toBe(false);
        expect(resolveEffectiveSettings(own, defaults()).plugins.shared.mode).toBe(PLUGIN_MODE.LAZY);
    });

    it("records facts about an inherited plugin in the Base, keeping it inherited", () => {
        const layers = data(profile());
        expect(layerProvidingPlugin(layers, "p", "shared")).toBe(layers.base);
        expect(overridesPlugin(layers.profiles.p.settings, "shared")).toBe(false);
    });

    it("records facts in the profile when it overrides the plugin or is a snapshot", () => {
        const overriding = data(profile({ plugins: { shared: {} } }));
        expect(layerProvidingPlugin(overriding, "p", "shared")).toBe(overriding.profiles.p.settings);
        const snapshot = data(profile({}, true));
        expect(layerProvidingPlugin(snapshot, "p", "shared")).toBe(snapshot.profiles.p.settings);
        expect(snapshot.base).toEqual(defaults());
    });

    it("resolves a profile-wide value from the profile, then its base layer", () => {
        expect(resolveDeviceValue(profile(), defaults(), "defaultMode")).toBe(PLUGIN_MODE.LAZY);
        expect(resolveDeviceValue(profile({ defaultMode: PLUGIN_MODE.ALWAYS_ENABLED }), defaults(), "defaultMode")).toBe(PLUGIN_MODE.ALWAYS_ENABLED);
        expect(resolveDeviceValue(profile({}, true), defaults(), "defaultMode")).toBe(DEFAULT_DEVICE_SETTINGS.defaultMode);
    });
});
