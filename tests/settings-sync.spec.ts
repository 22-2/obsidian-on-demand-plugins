import { access, copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type OnDemandPlugin from "src/main";
import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, useOnDemandPluginOnly } from "./test-utils";

useOnDemandPluginOnly();

type PersistedProfile = {
    id: string;
    name: string;
    settings: {
        defaultMode: string;
        plugins: Record<string, { mode?: string }>;
        lazyOnViews: Record<string, string[]>;
        lazyOnFiles: Record<string, { suffixes?: string[] }>;
    };
};

type PersistedSettings = {
    profiles: Record<string, PersistedProfile>;
    desktopProfileId: string;
    mobileProfileId: string;
};

function assertChildPath(parent: string, child: string, description: string): void {
    const relative = path.relative(parent, child);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${description} must stay inside the isolated test directory`);
    }
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

test("saved profiles survive a data.json-only replacement and reject stale writes", async ({ obsidian, tempDir }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const actualVaultPath = await obsidian.evaluateApp(() => {
        const adapter = app.vault.adapter as unknown as { getBasePath: () => string };
        return adapter.getBasePath();
    });
    const expectedVaultPath = path.resolve(`${tempDir}-vault`);
    const vaultRoot = await realpath(actualVaultPath);
    expect(vaultRoot).toBe(await realpath(expectedVaultPath));

    const pluginDirectory = await pluginHandle.evaluate((plugin: OnDemandPlugin) => plugin.manifest.dir);
    if (!pluginDirectory || path.isAbsolute(pluginDirectory)) {
        throw new Error("The plugin fixture must resolve to a relative directory inside the test vault");
    }

    const pluginPath = path.resolve(vaultRoot, pluginDirectory);
    assertChildPath(vaultRoot, pluginPath, "Plugin data path");
    // Reason: the test edits only toolkit-owned files and must never follow a plugin symlink into the repository.
    expect(await realpath(pluginPath)).toBe(pluginPath);

    const dataPath = path.join(pluginPath, "data.json");
    const profilesPath = path.join(pluginPath, "profiles");
    const desktopMarker = "__sync_e2e_desktop__";
    const mobileMarker = "__sync_e2e_mobile__";

    const profileIds = await pluginHandle.evaluate(async (plugin: OnDemandPlugin) => {
        const service = plugin.core.settingsService;
        const desktopId = service.createProfile("Desktop export");
        const mobileId = service.createProfile("Mobile export");

        service.data.profiles[desktopId].settings.defaultMode = "alwaysEnabled";
        service.data.profiles[desktopId].settings.plugins.__sync_e2e_desktop__ = { mode: "alwaysEnabled" };
        service.data.profiles[desktopId].settings.lazyOnViews.__sync_e2e_desktop__ = ["markdown"];
        service.data.profiles[mobileId].settings.defaultMode = "alwaysDisabled";
        service.data.profiles[mobileId].settings.plugins.__sync_e2e_mobile__ = { mode: "alwaysDisabled" };
        service.data.profiles[mobileId].settings.lazyOnFiles.__sync_e2e_mobile__ = { suffixes: [".mobile-sync"] };

        service.switchProfile(desktopId);
        service.setDeviceDefault(mobileId, "mobile");

        // Reason: keep the export focused on the two device profiles even if startup added a baseline profile.
        for (const profileId of Object.keys(service.data.profiles)) {
            if (profileId !== desktopId && profileId !== mobileId) service.deleteProfile(profileId);
        }

        // Reason: export through the real save path so the regression catches profiles omitted from data.json.
        await plugin.saveSettings();
        return { desktopId, mobileId };
    });

    expect(await pathExists(profilesPath)).toBe(false);
    const exportedRaw = await readFile(dataPath, "utf8");
    const exported = JSON.parse(exportedRaw) as PersistedSettings;
    expect(Object.keys(exported.profiles).sort()).toEqual([profileIds.desktopId, profileIds.mobileId].sort());
    expect(exported.desktopProfileId).toBe(profileIds.desktopId);
    expect(exported.mobileProfileId).toBe(profileIds.mobileId);
    expect(exported.profiles[profileIds.desktopId].settings.plugins[desktopMarker]?.mode).toBe("alwaysEnabled");
    expect(exported.profiles[profileIds.mobileId].settings.plugins[mobileMarker]?.mode).toBe("alwaysDisabled");

    const transferDirectory = path.resolve(tempDir, "settings-sync-transfer");
    assertChildPath(path.resolve(tempDir), transferDirectory, "Transfer fixture");
    await mkdir(transferDirectory, { recursive: true });
    const transferredDataPath = path.join(transferDirectory, "data.json");

    // Reason: replacing only this isolated vault's data.json exercises the receiver path without implying a Sync transport test.
    await copyFile(dataPath, transferredDataPath);
    await rm(dataPath);
    await copyFile(transferredDataPath, dataPath);
    expect(await pathExists(profilesPath)).toBe(false);

    await obsidian.evaluateApp(async (pluginId) => {
        await app.plugins.disablePlugin(pluginId);
        await app.plugins.enablePlugin(pluginId);
    }, pluginUnderTestId);

    const readLoadedSettings = async () =>
        obsidian.evaluateApp((pluginId) => {
            const plugin = (app.plugins.plugins as unknown as Record<string, OnDemandPlugin>)[pluginId];
            const service = plugin.core.settingsService;
            return {
                profileIds: Object.keys(plugin.data.profiles).sort(),
                desktopProfileId: plugin.data.desktopProfileId,
                mobileProfileId: plugin.data.mobileProfileId,
                activeProfileId: service.currentProfileId,
                activeDefaultMode: plugin.settings.defaultMode,
                desktopMarker: plugin.data.profiles[plugin.data.desktopProfileId]?.settings.plugins.__sync_e2e_desktop__?.mode ?? null,
                mobileMarker: plugin.data.profiles[plugin.data.mobileProfileId]?.settings.plugins.__sync_e2e_mobile__?.mode ?? null,
                mobileName: plugin.data.profiles[plugin.data.mobileProfileId]?.name ?? null,
            };
        }, pluginUnderTestId);

    const imported = await readLoadedSettings();
    expect(imported.profileIds).toEqual([profileIds.desktopId, profileIds.mobileId].sort());
    expect(imported.desktopProfileId).toBe(profileIds.desktopId);
    expect(imported.mobileProfileId).toBe(profileIds.mobileId);
    expect(imported.activeProfileId).toBe(profileIds.desktopId);
    expect(imported.activeDefaultMode).toBe("alwaysEnabled");
    expect(imported.desktopMarker).toBe("alwaysEnabled");
    expect(imported.mobileMarker).toBe("alwaysDisabled");

    const latestRaw = await readFile(dataPath, "utf8");
    const latest = JSON.parse(latestRaw) as PersistedSettings;
    latest.profiles[profileIds.mobileId].name = "Mobile profile received later";
    const receivedRaw = `${JSON.stringify(latest, null, 4)}\n`;
    await writeFile(dataPath, receivedRaw, "utf8");

    const staleSave = await obsidian.evaluateApp(async (pluginId) => {
        const plugin = (app.plugins.plugins as unknown as Record<string, OnDemandPlugin>)[pluginId];
        plugin.settings.defaultMode = "alwaysDisabled";
        try {
            await plugin.saveSettings();
            return { rejected: false, message: "" };
        } catch (error) {
            return { rejected: true, message: error instanceof Error ? error.message : String(error) };
        }
    }, pluginUnderTestId);

    expect(staleSave.rejected).toBe(true);
    expect(staleSave.message).toContain("Settings changed on disk after this plugin loaded");
    expect(await readFile(dataPath, "utf8")).toBe(receivedRaw);

    await obsidian.evaluateApp(async (pluginId) => {
        await app.plugins.disablePlugin(pluginId);
        await app.plugins.enablePlugin(pluginId);
    }, pluginUnderTestId);

    const afterReload = await readLoadedSettings();
    expect(afterReload.profileIds).toEqual([profileIds.desktopId, profileIds.mobileId].sort());
    expect(afterReload.desktopProfileId).toBe(profileIds.desktopId);
    expect(afterReload.mobileProfileId).toBe(profileIds.mobileId);
    expect(afterReload.activeProfileId).toBe(profileIds.desktopId);
    expect(afterReload.activeDefaultMode).toBe("alwaysEnabled");
    expect(afterReload.mobileName).toBe("Mobile profile received later");
    expect(afterReload.mobileMarker).toBe("alwaysDisabled");
    expect(await pathExists(profilesPath)).toBe(false);
});
