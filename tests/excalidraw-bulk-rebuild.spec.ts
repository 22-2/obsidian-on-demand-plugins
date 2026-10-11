import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { ensureBuilt, excalidrawPluginId, pluginUnderTestId, readOnDemandStorageValue, resolveMyfilesPluginPath, useVaultPlugins, waitForPluginLoaded, waitForViewType } from "./test-utils";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const FILLER_PLUGIN_COUNT = 28;

/** Filler plugins mimic a real vault: sync and async onloads, CPU work, views, and layout-ready work. */
function createFillerPlugins(): string[] {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "on-demand-bulk-"));
    return Array.from({ length: FILLER_PLUGIN_COUNT }, (_, index) => {
        const id = `bulk-filler-${String(index).padStart(2, "0")}`;
        const dir = path.join(root, id);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, name: `Bulk filler ${index}`, version: "1.0.0", minAppVersion: "1.0.0", description: "", author: "test" }));
        fs.writeFileSync(
            path.join(dir, "main.js"),
            `const { Plugin, ItemView } = require("obsidian");
module.exports = class extends Plugin {
    async onload() {
        const busyUntil = Date.now() + ${20 + (index % 5) * 15};
        while (Date.now() < busyUntil) {}
        this.addCommand({ id: "first", name: "First", callback() {} });
        await new Promise((resolve) => setTimeout(resolve, ${(index * 37) % 250}));
        this.addCommand({ id: "second", name: "Second", callback() {} });
        ${index % 3 === 0 ? `this.registerView("${id}-view", (leaf) => new (class extends ItemView { getViewType() { return "${id}-view"; } getDisplayText() { return "${id}"; } })(leaf));` : ""}
        this.app.workspace.onLayoutReady(() => this.addCommand({ id: "ready", name: "Ready", callback() {} }));
    }
};
`,
        );
        return dir;
    });
}

const fillerPaths = createFillerPlugins();
const fillerIds = fillerPaths.map((p) => path.basename(p));
useVaultPlugins([repoRoot, resolveMyfilesPluginPath(excalidrawPluginId), path.join(repoRoot, "tests/fixtures/cache-async"), ...fillerPaths]);

for (let attempt = 1; attempt <= 3; attempt++) {
    test(`bulk rebuild with 30 lazy plugins captures latest Excalidraw (run ${attempt})`, async ({ obsidian }) => {
        if (!ensureBuilt()) return;
        await obsidian.waitReady();
        const handle = await obsidian.plugin(pluginUnderTestId);
        const ids = [excalidrawPluginId, "cache-async", ...fillerIds];
        const result = await handle.evaluate(async (plugin: OnDemandPlugin, pluginIds: string[]) => {
            for (const id of pluginIds) {
                plugin.settings.plugins[id] = {
                    mode: "lazy",
                    userConfigured: true,
                    lazyOptions: { useView: true, viewTypes: [], useFile: false, fileCriteria: {} },
                };
                await app.plugins.disablePlugin(id);
            }
            const originalReload = app.commands.executeCommandById;
            app.commands.executeCommandById = () => true;
            let error: string | null = null;
            try {
                await plugin.rebuildAndApplyCommandCache({ force: true });
            } catch (e) {
                const errors = e instanceof AggregateError ? e.errors : [e];
                error = errors.map((x) => String((x as Error)?.stack ?? x)).join("\n");
            } finally {
                app.commands.executeCommandById = originalReload;
            }
            return {
                error,
                excalidrawViews: plugin.settings.plugins["obsidian-excalidraw-plugin"].lazyOptions?.viewTypes ?? [],
                loaded: pluginIds.filter((id) => !!app.plugins.plugins[id]?._loaded),
            };
        }, ids);

        expect(result.error).toBeNull();
        expect(result.loaded).toEqual([]);
        expect(result.excalidrawViews).toContain("excalidraw");
        const commands = (await readOnDemandStorageValue(obsidian, "commandCache", excalidrawPluginId)) as unknown[] | null;
        expect(commands?.length ?? 0).toBeGreaterThan(10);

        // The rebuilt cache must still lazy-load Excalidraw when its file is opened.
        await obsidian.page.evaluate(async () => {
            const file = await app.vault.create("bulk.excalidraw.md", '---\nexcalidraw-plugin: parsed\n---\n\n# Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n```\n');
            await app.workspace.getLeaf(false).openFile(file);
        });
        expect(await waitForPluginLoaded(obsidian, excalidrawPluginId, 10_000)).toBe(true);
        expect(await waitForViewType(obsidian, "excalidraw", 10_000)).toBe(true);
    });
}
