import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, useOnDemandPluginOnly } from "./test-utils";

useOnDemandPluginOnly();

const fixtureId = "lazy-editor-fixture";
const commandId = `${fixtureId}:insert-marker`;
const marker = "LAZY-EDITOR-OK";

test("lazy wrapper runs an editorCallback command in the active editor", async ({ obsidian }) => {
    if (!ensureBuilt()) return;
    await obsidian.waitReady();

    // Obsidian turns editorCallback into a generated checkCallback when the command is added;
    // executing the real command must go through that path once the plugin loads lazily.
    await obsidian.page.evaluate(
        async ({ id, marker }) => {
            const dir = `${app.vault.configDir}/plugins/${id}`;
            await app.vault.adapter.mkdir(dir);
            await app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify({
                id, name: "Lazy editor fixture", version: "1.0.0", minAppVersion: "1.0.0",
                description: "Registers an editor command for lazy execution tests.", author: "E2E", isDesktopOnly: false,
            }));
            await app.vault.adapter.write(`${dir}/main.js`, `
                const { Plugin } = require("obsidian");
                module.exports = class extends Plugin {
                    onload() {
                        this.addCommand({
                            id: "insert-marker",
                            name: "Insert marker",
                            editorCallback: (editor) => editor.replaceSelection(${JSON.stringify(marker)}),
                        });
                    }
                };
            `);
            await (app.plugins as unknown as { loadManifests: () => Promise<void> }).loadManifests();
        },
        { id: fixtureId, marker },
    );

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate(async (instance, id) => {
        instance.updateManifests();
        await instance.updatePluginSettings(id, "lazy");
    }, fixtureId);
    // Caching the commands loads the plugin without adding it to enabledPlugins. Applying lazy
    // mode must still unload it and leave the cached wrapper in place of the real command.
    await expect.poll(() => obsidian.page.evaluate(({ id, commandId }) => ({
        loaded: Boolean(app.plugins.plugins[id]?._loaded),
        hasWrapper: commandId in app.commands.commands,
    }), { id: fixtureId, commandId })).toEqual({ loaded: false, hasWrapper: true });

    await obsidian.page.evaluate(async () => {
        const file = await app.vault.create("lazy-editor-command.md", "");
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        app.workspace.activeEditor?.editor?.focus();
    });

    await obsidian.page.evaluate((commandId) => app.commands.executeCommandById(commandId), commandId);

    await expect.poll(() => obsidian.page.evaluate(() => app.workspace.activeEditor?.editor?.getValue())).toBe(marker);
    expect(await obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), fixtureId)).toBe(true);
});
