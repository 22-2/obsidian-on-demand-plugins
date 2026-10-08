import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    findCommandByExactId,
    pluginUnderTestId,
    readOnDemandStorageValue,
    useOnDemandPluginsWithTargets,
    waitForPluginDisabled,
} from "./test-utils";

const myCommandsPluginId = "my-commands-plugin";
const duplicateCurrentTabCommandId = `${myCommandsPluginId}:duplicate-current-tab`;

useOnDemandPluginsWithTargets(myCommandsPluginId);

type OnDemandPluginController = {
    updatePluginSettings: (pluginId: string, mode: string) => Promise<void>;
    rebuildAndApplyCommandCache: (options?: { force?: boolean }) => Promise<void>;
};

type ObsidianPluginAccessor = {
    plugin: (pluginId: string) => Promise<{
        evaluate: <TArg>(pageFunction: (plugin: OnDemandPluginController, arg: TArg) => Promise<void>, arg: TArg) => Promise<void>;
    }>;
};

async function configureMyCommandsPluginAsLazy(obsidian: ObsidianPluginAccessor) {
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, pluginId) => {
        const original = app.commands.executeCommandById;
        app.commands.executeCommandById = () => true;

        try {
            await plugin.updatePluginSettings(pluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = original;
        }
    }, myCommandsPluginId);
}

test("my-commands duplicate-current-tab is cached and restored as a lazy wrapper", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    await configureMyCommandsPluginAsLazy(obsidian);

    expect(await waitForPluginDisabled(obsidian, myCommandsPluginId, 15_000)).toBe(true);

    const cachedCommands = await readOnDemandStorageValue(obsidian, "commandCache", myCommandsPluginId);

    // This pins the restart path: wrapper registration only works if the rebuilt cache
    // actually persisted the command that users later expect to see in the palette.
    expect(Array.isArray(cachedCommands)).toBe(true);
    expect((cachedCommands as Array<{ id: string }>).some((command) => command.id === duplicateCurrentTabCommandId)).toBe(true);

    const registeredCommandId = await findCommandByExactId(obsidian, duplicateCurrentTabCommandId);

    // This distinguishes "cached but never re-registered" from "missing from cache".
    expect(registeredCommandId).toBe(duplicateCurrentTabCommandId);

    const executionState = await obsidian.page.evaluate(async ({ pluginId, commandId }) => {
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
    }, { pluginId: myCommandsPluginId, commandId: duplicateCurrentTabCommandId });

    // The wrapper should at least load the plugin instance; if the command object stays the
    // same, the target plugin never re-registered its real command after lazy enable.
    expect(executionState.loaded).toBe(true);
    expect(executionState.commandReplaced).toBe(true);
});

test("my-commands plugin can be manually re-enabled after lazy rebuild", async ({ obsidian }) => {
    if (!ensureBuilt()) return;

    await obsidian.waitReady();

    await configureMyCommandsPluginAsLazy(obsidian);

    expect(await waitForPluginDisabled(obsidian, myCommandsPluginId, 15_000)).toBe(true);

    // This isolates plugin re-enable behavior from wrapper execution so failures here point
    // at the plugin lifecycle itself rather than command replacement.
    const enableState = await obsidian.page.evaluate(async ({ pluginId, commandId }) => {
        const beforeCommand = app.commands.commands?.[commandId] ?? null;

        await app.plugins.enablePlugin(pluginId);

        const afterCommand = app.commands.commands?.[commandId] ?? null;
        return {
            loaded: Boolean(app.plugins.plugins?.[pluginId]?._loaded),
            commandReplaced: beforeCommand !== afterCommand,
        };
    }, { pluginId: myCommandsPluginId, commandId: duplicateCurrentTabCommandId });

    expect(enableState.loaded).toBe(true);
    expect(enableState.commandReplaced).toBe(true);
});
