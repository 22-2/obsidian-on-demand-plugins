import { PLUGIN_MODE } from "src/core/types";
import { createPluginTableHost } from "src/features/plugin-table/plugin-table-host";
import type OnDemandPlugin from "src/main";
import type { DraftSession } from "src/ui/drafts/draft-session";
import { LazyOptionsModal } from "src/ui/modals/lazy-options-modal";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => await import("src/__mocks__/obsidian"));
vi.mock("src/ui/modals/lazy-options-modal", () => ({ LazyOptionsModal: vi.fn(function () {
    return { open: vi.fn() };
}) }));

function setup() {
    const manifests = [{ id: "alpha", name: "Alpha" }];
    const plugin = {
        app: {},
        manifest: { id: "on-demand-plugins", name: "On-Demand" },
        manifests: [] as unknown[],
        settings: { plugins: {} as Record<string, unknown> },
        updateManifests: vi.fn(function (this: { manifests: unknown[] }) {
            this.manifests = manifests;
        }),
        getPluginMode: vi.fn(() => PLUGIN_MODE.LAZY),
    };
    const drafts = {} as DraftSession;
    return { plugin, drafts, host: createPluginTableHost(plugin as unknown as OnDemandPlugin, drafts) };
}

describe("plugin table host", () => {
    it("reloads the manifests before listing them, and lists On-Demand itself", () => {
        const { host, plugin } = setup();
        expect(host.selfId).toBe("on-demand-plugins");
        expect(host.getManifests()).toEqual([
            { id: "alpha", name: "Alpha" },
            { id: "on-demand-plugins", name: "On-Demand" },
        ]);
        expect(plugin.updateManifests).toHaveBeenCalledOnce();
    });

    it("passes through the app, the draft and the current mode", () => {
        const { host, plugin, drafts } = setup();
        expect(host.app).toBe(plugin.app);
        expect(host.drafts).toBe(drafts);
        expect(host.getMode("alpha")).toBe(PLUGIN_MODE.LAZY);
    });

    it("stages a mode in the live settings and reports whether it changed", () => {
        const { host, plugin } = setup();
        expect(host.stageMode("alpha", PLUGIN_MODE.LAZY)).toBe(false);
        expect(host.stageMode("alpha", PLUGIN_MODE.ALWAYS_ENABLED)).toBe(true);
        expect(plugin.settings.plugins.alpha).toEqual({ mode: PLUGIN_MODE.ALWAYS_ENABLED, userConfigured: true });
    });

    it("opens the lazy options modal for a plugin", () => {
        const { host, plugin } = setup();
        const onSave = vi.fn();
        host.openLazyOptions("alpha", onSave);
        expect(LazyOptionsModal).toHaveBeenCalledWith(plugin.app, plugin, "alpha", onSave);
        const modal = vi.mocked(LazyOptionsModal).mock.results[0].value as { open: Mock };
        expect(modal.open).toHaveBeenCalledOnce();
    });
});
