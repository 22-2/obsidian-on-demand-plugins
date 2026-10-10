import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { ensureBuilt, pluginUnderTestId, readOnDemandStorageValue, useVaultPlugins } from "./test-utils";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
useVaultPlugins([repoRoot, path.join(repoRoot, "tests/fixtures/cache-async"), path.join(repoRoot, "tests/fixtures/cache-empty")]);

test("rebuild captures async commands and views in one load, including empty snapshots", async ({ obsidian }) => {
    if (!ensureBuilt()) return;
    await obsidian.waitReady();
    await expect.poll(() => obsidian.page.evaluate(() => !!app.commands.commands["cache-async:late"])).toBe(true);
    const handle = await obsidian.plugin(pluginUnderTestId);
    const result = await handle.evaluate(async (plugin: OnDemandPlugin) => {
        const ids = ["cache-async", "cache-empty"];
        for (const id of ids) {
            plugin.settings.plugins[id] = {
                mode: "lazy",
                userConfigured: true,
                lazyOptions: { useView: true, viewTypes: id === "cache-empty" ? [] : ["removed-view"], useFile: false, fileCriteria: {} },
            };
            plugin.settings.lazyOnViews[id] = ["removed-view"];
            await app.plugins.disablePlugin(id);
        }
        const originalReload = app.commands.executeCommandById;
        const originalEnable = app.plugins.enablePlugin;
        const loads: string[] = [];
        app.commands.executeCommandById = () => true;
        app.plugins.enablePlugin = async function (id) {
            loads.push(id);
            return originalEnable.call(this, id);
        };
        try {
            const started = performance.now();
            await plugin.rebuildAndApplyCommandCache({ force: true });
            const elapsedMs = performance.now() - started;
            const firstLoads = [...loads];
            loads.length = 0;
            await plugin.rebuildAndApplyCommandCache();
            return {
                elapsedMs,
                firstLoads,
                subsequentLoads: loads,
                views: ids.map((id) => plugin.settings.plugins[id].lazyOptions?.viewTypes),
                mappings: ids.map((id) => plugin.settings.lazyOnViews[id]),
                loaded: ids.map((id) => !!app.plugins.plugins[id]?._loaded),
            };
        } finally {
            app.commands.executeCommandById = originalReload;
            app.plugins.enablePlugin = originalEnable;
        }
    });
    console.log(`Combined cache rebuild: ${Math.round(result.elapsedMs)}ms`);
    expect(result.firstLoads.sort()).toEqual(["cache-async", "cache-empty"]);
    expect(result.subsequentLoads).toEqual([]);
    expect(result.views).toEqual([["cache-async-view"], []]);
    expect(result.mappings).toEqual(result.views);
    expect(result.loaded).toEqual([false, false]);
    const commands = await readOnDemandStorageValue(obsidian, "commandCache", "cache-async");
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ id: "cache-async:early" }), expect.objectContaining({ id: "cache-async:late" })]));
    expect(await readOnDemandStorageValue(obsidian, "commandCache", "cache-empty")).toEqual([]);
    expect(await readOnDemandStorageValue(obsidian, "commandCacheVersions", "cache-empty")).toBe("1.0.0");
});
