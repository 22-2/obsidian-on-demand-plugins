import { expect, test } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { ensureBuilt, pluginUnderTestId, targetPluginId, useOnDemandPlugins } from "./test-utils";

useOnDemandPlugins();

// An id that is guaranteed not to exist in the vault's installed manifests.
const GHOST_ID = "__ghost_uninstalled_plugin__";

test("prune removes uninstalled-plugin entries but keeps installed ones", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(
        async (plugin: OnDemandPlugin, args) => {
            const { ghostId, installedId } = args;

            // Seed stale state for a plugin that is no longer installed, across all
            // three per-profile maps the cleanup targets.
            plugin.settings.plugins[ghostId] = { mode: "lazy", userConfigured: true };
            plugin.settings.lazyOnViews[ghostId] = ["ghost-view"];
            plugin.settings.lazyOnFiles[ghostId] = { suffixes: [".ghost"] };
            // And a real entry for an installed plugin that must survive the prune.
            plugin.settings.plugins[installedId] = { mode: "lazy", userConfigured: true };

            plugin.settings.pruneUninstalledEntries = true;
            const pruned = await plugin.backupAndPruneUninstalledEntries();
            await plugin.saveSettings();

            // Re-read data.json to confirm the removal was persisted, not just in-memory.
            const dataRaw = await app.vault.adapter.read(`${plugin.manifest.dir}/data.json`);

            return {
                pruned,
                ghostInPlugins: ghostId in plugin.settings.plugins,
                ghostInViews: ghostId in plugin.settings.lazyOnViews,
                ghostInFiles: ghostId in plugin.settings.lazyOnFiles,
                installedMode: plugin.settings.plugins[installedId]?.mode ?? null,
                ghostInDisk: dataRaw.includes(ghostId),
            };
        },
        { ghostId: GHOST_ID, installedId: targetPluginId },
    );

    expect(result.pruned).toBe(true);
    expect(result.ghostInPlugins).toBe(false);
    expect(result.ghostInViews).toBe(false);
    expect(result.ghostInFiles).toBe(false);
    expect(result.installedMode).toBe("lazy");
    expect(result.ghostInDisk).toBe(false);
});

test("prune is skipped while the toggle is off", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(
        async (plugin: OnDemandPlugin, ghostId) => {
            plugin.settings.plugins[ghostId] = { mode: "lazy", userConfigured: true };
            plugin.settings.pruneUninstalledEntries = false;

            // setupDefaultPluginConfigurations() runs the cleanup, but only when the
            // toggle is enabled, so the stale entry must remain.
            await plugin.setupDefaultPluginConfigurations();

            return { ghostStillThere: ghostId in plugin.settings.plugins };
        },
        GHOST_ID,
    );

    expect(result.ghostStillThere).toBe(true);
});

test("legacy command-cache fields are stripped from data.json on load", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const result = await pluginHandle.evaluate(async (plugin: OnDemandPlugin) => {
        // Simulate an old install whose data.json still carries the now-unused cache
        // (the live cache lives in vault-scoped storage, not data.json).
        plugin.data.commandCache = { "old-plugin": [{ id: "cmd", name: "Cmd" }] };
        plugin.data.commandCacheVersions = { "old-plugin": "1.0.0" };
        await plugin.saveSettings();

        const beforeRaw = await app.vault.adapter.read(`${plugin.manifest.dir}/data.json`);

        // Reload re-reads data.json; load() drops the legacy fields. Save to persist.
        await plugin.loadSettings();
        await plugin.saveSettings();

        const afterRaw = await app.vault.adapter.read(`${plugin.manifest.dir}/data.json`);

        return {
            beforeHadCache: beforeRaw.includes('"commandCache"'),
            afterMemoryCache: plugin.data.commandCache ?? null,
            afterMemoryVersions: plugin.data.commandCacheVersions ?? null,
            afterDiskHasCache: afterRaw.includes('"commandCache"'),
            afterDiskHasVersions: afterRaw.includes('"commandCacheVersions"'),
        };
    });

    expect(result.beforeHadCache).toBe(true);
    expect(result.afterMemoryCache).toBeNull();
    expect(result.afterMemoryVersions).toBeNull();
    expect(result.afterDiskHasCache).toBe(false);
    expect(result.afterDiskHasVersions).toBe(false);
});
