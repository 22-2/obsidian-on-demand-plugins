import type { App, PluginManifest } from "obsidian";
import { Notice } from "src/__mocks__/obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { ON_DEMAND_PLUGIN_ID } from "src/core/constants";
import type { PluginContext } from "src/core/plugin-context";
import type { PLUGIN_MODE as PluginMode } from "src/core/types";
import { PLUGIN_MODE } from "src/core/types";
import { CommunityPluginsDriftFeature } from "src/features/community-plugins-drift/community-plugins-drift-feature";
import { patchPluginEnableDisable } from "src/patches/plugin-enable-disable";
import { PluginRegistry } from "src/services/registry/plugin-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/confirm-modal", () => ({ showConfirmModal: vi.fn() }));

/**
 * Models the parts of Obsidian 1.14's `Plugins` that touch community-plugins.json,
 * following app.js: the *AndSave variants pass the user flag and persist the
 * in-memory set; restricted mode (`setEnable`) and `plugin:reload` call the plain
 * methods without the flag and never write the file.
 */
class FakeObsidian {
    readonly files = new Map<string, unknown>();
    readonly manifests: Record<string, PluginManifest> = {};
    readonly plugins: Record<string, { _loaded: boolean }> = {};
    enabledPlugins = new Set<string>();
    restricted = false;
    private unloadHandlers: (() => void)[] = [];

    readonly vault = {
        readConfigJson: async (name: string) => structuredClone(this.files.get(name) ?? null),
        writeConfigJson: async (name: string, value: unknown) => {
            this.files.set(name, structuredClone(value));
        },
        getConfigFile: (name: string) => `.obsidian/${name}.json`,
        adapter: {
            exists: async (path: string) => this.files.has(FakeObsidian.configName(path)),
            write: async (path: string, data: string) => {
                this.files.set(FakeObsidian.configName(path), JSON.parse(data));
            },
            process: async (path: string, fn: (data: string) => string) => {
                const data = fn(JSON.stringify(this.files.get(FakeObsidian.configName(path))));
                this.files.set(FakeObsidian.configName(path), JSON.parse(data));
                return data;
            },
        },
    };

    private static configName(path: string) {
        return path.replace(/^\.obsidian\//, "").replace(/\.json$/, "");
    }

    readonly workspace = { onLayoutReady: (callback: () => void) => callback() };

    readonly api = {
        manifests: this.manifests,
        plugins: this.plugins,
        get enabledPlugins() {
            return fake.enabledPlugins;
        },
        enablePlugin: async (id: string, _isUserEnabled = false) => {
            if (this.restricted || !this.manifests[id]) return false;
            this.plugins[id] = { _loaded: true };
            return true;
        },
        disablePlugin: async (id: string, _isUserDisabled = false) => {
            delete this.plugins[id];
        },
        enablePluginAndSave: async (id: string) => {
            if (!(await this.api.enablePlugin(id, true))) return false;
            this.enabledPlugins.add(id);
            await this.saveConfig();
            return true;
        },
        disablePluginAndSave: async (id: string) => {
            this.enabledPlugins.delete(id);
            await this.saveConfig();
            await this.api.disablePlugin(id, true);
        },
        /** Restricted mode toggle: unloads/reloads every plugin without touching the file. */
        setEnable: async (enabled: boolean) => {
            this.restricted = !enabled;
            if (!enabled) {
                for (const id of Object.keys(this.plugins)) await this.api.disablePlugin(id);
            } else {
                for (const id of Array.from(this.enabledPlugins)) await this.api.enablePlugin(id);
            }
        },
    };

    constructor(ids: string[]) {
        for (const id of ids) this.manifests[id] = { id, name: `Name of ${id}` } as PluginManifest;
    }

    async saveConfig() {
        await this.vault.writeConfigJson("community-plugins", Array.from(this.enabledPlugins));
    }

    get communityPlugins(): string[] {
        return ((this.files.get("community-plugins") as string[] | undefined) ?? []).slice().sort();
    }

    register(unload: () => void) {
        this.unloadHandlers.push(unload);
    }

    unloadOnDemand() {
        this.unloadHandlers.splice(0).forEach((unload) => unload());
    }
}

let fake: FakeObsidian;

function setup(modes: Record<string, PluginMode>) {
    const ids = Object.keys(modes);
    fake = new FakeObsidian(ids);
    const settings = { plugins: Object.fromEntries(ids.map((id) => [id, { mode: modes[id], userConfigured: true }])) as Record<string, { mode: PluginMode; userConfigured: boolean }> };
    const desiredOnDisk = [ON_DEMAND_PLUGIN_ID, ...ids.filter((id) => modes[id] === PLUGIN_MODE.ALWAYS_ENABLED)];
    fake.files.set("community-plugins", desiredOnDisk);
    fake.enabledPlugins = new Set(desiredOnDisk);
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const manifests = ids.map((id) => fake.manifests[id]);
    const app = { vault: fake.vault, workspace: fake.workspace, plugins: fake.api } as unknown as App;
    const registry = new PluginRegistry(app, fake.api);
    const ctx = {
        app,
        obsidianPlugins: fake.api,
        getManifests: () => manifests,
        getPluginMode: (id: string) => settings.plugins[id]?.mode ?? PLUGIN_MODE.LAZY,
        getData: () => ({ showConsoleLog: false }),
        getSettings: () => settings,
        register: (unload: () => void) => fake.register(unload),
    } as unknown as PluginContext;
    const enableDisableHooks = {
        setPluginMode: async (id: string, mode: PluginMode) => {
            settings.plugins[id] = { ...settings.plugins[id], mode, userConfigured: true };
            await saveSettings();
        },
        syncCommandWrappers: vi.fn(),
    };

    const loadOnDemand = async () => {
        await registry.loadEnabledPluginsFromDisk();
        patchPluginEnableDisable(ctx, enableDisableHooks);
        const feature = new CommunityPluginsDriftFeature();
        feature.onload(ctx, { registry } as never, {} as never, {} as never);
        // onLayoutReady runs the startup check synchronously in this fake; let it settle.
        await vi.waitFor(() => expect(registry.enabledPluginsFromDisk.size).toBeGreaterThan(0));
        return feature;
    };
    return { settings, saveSettings, registry, loadOnDemand, modeOf: (id: string) => settings.plugins[id].mode };
}

function range(prefix: string, count: number) {
    return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
}

describe("CommunityPluginsDriftFeature with Obsidian's plugin toggles", () => {
    const enabled = range("on", 40);
    const disabled = range("off", 30);
    const lazy = range("lazy", 20);
    const modes = {
        ...Object.fromEntries(enabled.map((id) => [id, PLUGIN_MODE.ALWAYS_ENABLED])),
        ...Object.fromEntries(disabled.map((id) => [id, PLUGIN_MODE.ALWAYS_DISABLED])),
        ...Object.fromEntries(lazy.map((id) => [id, PLUGIN_MODE.LAZY])),
    } as Record<string, PluginMode>;

    beforeEach(() => {
        Notice.clearMessages();
        vi.mocked(showConfirmModal).mockReset();
    });

    it("reports nothing on a clean start", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();
        expect(await feature.detect()).toBeNull();
        expect(Notice.messages).toEqual([]);
    });

    it("keeps every mode through restricted mode on and off and reports nothing afterwards", async () => {
        const t = setup(modes);
        await t.loadOnDemand();
        for (const id of enabled) await fake.api.enablePlugin(id);

        await fake.api.setEnable(false);
        // Turning restricted mode on unloads On-Demand too; its patch goes with it.
        fake.unloadOnDemand();
        await fake.api.setEnable(true);
        const feature = await t.loadOnDemand();

        expect(enabled.every((id) => t.modeOf(id) === PLUGIN_MODE.ALWAYS_ENABLED)).toBe(true);
        expect(t.saveSettings).not.toHaveBeenCalled();
        expect(await feature.detect()).toBeNull();
        expect(Notice.messages).toEqual([]);
    });

    it("does not change modes when restricted mode unloads plugins before On-Demand", async () => {
        const t = setup(modes);
        await t.loadOnDemand();
        for (const id of enabled) await fake.api.enablePlugin(id);

        // Obsidian disables in load order; plugins listed before On-Demand still see the patch.
        for (const id of enabled) await fake.api.disablePlugin(id);
        expect(enabled.every((id) => t.modeOf(id) === PLUGIN_MODE.ALWAYS_ENABLED)).toBe(true);
        expect(t.saveSettings).not.toHaveBeenCalled();
    });

    it("reports external edits made while restricted mode was on once On-Demand loads again", async () => {
        const t = setup(modes);
        await t.loadOnDemand();
        await fake.api.setEnable(false);
        fake.unloadOnDemand();
        // e.g. Sync delivers another device's list while this vault is restricted.
        await fake.vault.writeConfigJson("community-plugins", [ON_DEMAND_PLUGIN_ID, ...enabled.slice(10), ...lazy.slice(0, 5)]);
        await fake.api.setEnable(true);
        await t.loadOnDemand();

        await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
        expect(Notice.messages[0]).toContain("enabled 5 (Name of lazy-00, Name of lazy-01, Name of lazy-02, +2 more)");
        expect(Notice.messages[0]).toContain("disabled 10 (Name of on-00, Name of on-01, Name of on-02, +7 more)");
    });

    it("follows dozens of CLI/Community-tab enables at once without reporting them", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();

        // `obsidian plugin:enable id=…` for every disabled plugin in parallel.
        await Promise.all(disabled.map((id) => fake.api.enablePluginAndSave(id)));

        expect(disabled.every((id) => t.modeOf(id) === PLUGIN_MODE.ALWAYS_ENABLED)).toBe(true);
        expect(fake.communityPlugins).toEqual([ON_DEMAND_PLUGIN_ID, ...enabled, ...disabled].sort());
        expect(await feature.detect()).toBeNull();
    });

    it("follows dozens of CLI/Community-tab disables at once without reporting them", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();

        await Promise.all(enabled.map((id) => fake.api.disablePluginAndSave(id)));

        expect(enabled.every((id) => t.modeOf(id) === PLUGIN_MODE.ALWAYS_DISABLED)).toBe(true);
        expect(fake.communityPlugins).toEqual([ON_DEMAND_PLUGIN_ID]);
        expect(await feature.detect()).toBeNull();
    });

    it("reports lazy plugins enabled through the CLI, since their mode stays lazy", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();

        await Promise.all(lazy.map((id) => fake.api.enablePluginAndSave(id)));

        expect(lazy.every((id) => t.modeOf(id) === PLUGIN_MODE.LAZY)).toBe(true);
        expect((await feature.detect())?.enabledExternally).toEqual(lazy);
    });

    it("reports exactly the entries of an arbitrary external rewrite", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();
        const all = [...enabled, ...disabled, ...lazy];
        const onDisk = all.filter((_, i) => (i * 7) % 3 === 0);
        await fake.vault.writeConfigJson("community-plugins", [ON_DEMAND_PLUGIN_ID, ...onDisk, "not-installed-here"]);

        const drift = await feature.detect();

        const desired = new Set(enabled);
        expect(drift?.enabledExternally).toEqual(onDisk.filter((id) => !desired.has(id)).sort());
        expect(drift?.disabledExternally).toEqual(enabled.filter((id) => !onDisk.includes(id)).sort());
        expect(drift?.selfMissing).toBe(false);
    });

    it("stops reporting once On-Demand writes the file itself", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();
        await fake.vault.writeConfigJson("community-plugins", [ON_DEMAND_PLUGIN_ID]);
        expect(await feature.detect()).not.toBeNull();

        await t.registry.writeCommunityPluginsFile(feature.getDesired());

        expect(await feature.detect()).toBeNull();
    });

    it("asks before overwriting and passes the user's answer through", async () => {
        const t = setup(modes);
        const feature = await t.loadOnDemand();
        expect(await feature.confirmOverwrite()).toBe(true);
        expect(showConfirmModal).not.toHaveBeenCalled();

        await fake.vault.writeConfigJson("community-plugins", []);
        vi.mocked(showConfirmModal).mockResolvedValueOnce(false).mockResolvedValueOnce(null).mockResolvedValueOnce(true);
        expect(await feature.confirmOverwrite()).toBe(false);
        expect(await feature.confirmOverwrite()).toBe(false);
        expect(await feature.confirmOverwrite()).toBe(true);
        expect(vi.mocked(showConfirmModal).mock.calls[0][1].message).toContain("removed On-Demand Plugins itself");
    });
});
