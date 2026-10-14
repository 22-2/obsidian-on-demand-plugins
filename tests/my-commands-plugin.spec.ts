import { expect, test } from "./fixtures";
import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { pluginUnderTestId, readOnDemandStorageValue, useOnDemandPluginsWithTargets, withReloadRecorded } from "./test-utils";

const myCommandsPluginId = "my-commands-plugin";
const duplicateCurrentTabCommandId = `${myCommandsPluginId}:duplicate-current-tab`;

useOnDemandPluginsWithTargets(myCommandsPluginId);

async function configureMyCommandsPluginAsLazy(obsidian: ObsidianAPI) {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        }, myCommandsPluginId),
    );
}

test("my-commands duplicate-current-tab is cached and restored as a lazy wrapper", async ({ obsidian }) => {
    await configureMyCommandsPluginAsLazy(obsidian);

    await obsidian.waitForPluginUnloaded(myCommandsPluginId, 15_000);

    const cachedCommands = await readOnDemandStorageValue(obsidian, "commandCache", myCommandsPluginId);

    // This pins the restart path: wrapper registration only works if the rebuilt cache
    // actually persisted the command that users later expect to see in the palette.
    expect(Array.isArray(cachedCommands)).toBe(true);
    expect((cachedCommands as Array<{ id: string }>).some((command) => command.id === duplicateCurrentTabCommandId)).toBe(true);

    const registeredCommandId = await obsidian.hasCommand(duplicateCurrentTabCommandId);

    // This distinguishes "cached but never re-registered" from "missing from cache".
    expect(registeredCommandId).toBe(true);

    const executionState = await obsidian.page.evaluate(
        async ({ pluginId, commandId }) => {
            const deadline = Date.now() + 45_000;
            const before = app.commands.commands[commandId];

            await app.commands.executeCommandById(commandId);

            let after = app.commands.commands[commandId];
            let loaded = Boolean(app.plugins.plugins?.[pluginId]?._loaded);

            while (Date.now() < deadline) {
                after = app.commands.commands[commandId];
                loaded = Boolean(app.plugins.plugins?.[pluginId]?._loaded);

                if (loaded && before !== after) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 200));
            }

            return {
                loaded,
                commandReplaced: before !== after,
            };
        },
        { pluginId: myCommandsPluginId, commandId: duplicateCurrentTabCommandId },
    );

    // The wrapper should at least load the plugin instance; if the command object stays the
    // same, the target plugin never re-registered its real command after lazy enable.
    expect(executionState.loaded).toBe(true);
    expect(executionState.commandReplaced).toBe(true);
});

test("my-commands plugin can be manually re-enabled after lazy rebuild", async ({ obsidian }) => {
    await configureMyCommandsPluginAsLazy(obsidian);

    await obsidian.waitForPluginUnloaded(myCommandsPluginId, 15_000);

    // This isolates plugin re-enable behavior from wrapper execution so failures here point
    // at the plugin lifecycle itself rather than command replacement.
    const enableState = await obsidian.page.evaluate(
        async ({ pluginId, commandId }) => {
            const beforeCommand = app.commands.commands?.[commandId] ?? null;

            await app.plugins.enablePlugin(pluginId);

            const afterCommand = app.commands.commands?.[commandId] ?? null;
            return {
                loaded: Boolean(app.plugins.plugins?.[pluginId]?._loaded),
                commandReplaced: beforeCommand !== afterCommand,
            };
        },
        { pluginId: myCommandsPluginId, commandId: duplicateCurrentTabCommandId },
    );

    expect(enableState.loaded).toBe(true);
    expect(enableState.commandReplaced).toBe(true);
});
