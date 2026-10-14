import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, useOnDemandPluginsWithTargets, withReloadRecorded } from "./test-utils";

const notebookNavigatorId = "notebook-navigator";
const notebookNavigatorViewType = "notebook-navigator";

useOnDemandPluginsWithTargets(notebookNavigatorId);

/** The leaf holding the navigator, and whether the plugin's own view (not a placeholder) is rendered in it. */
async function readNavigatorLeaf(obsidian: ObsidianAPI) {
    return obsidian.page.evaluate((viewType) => {
        const leaf = app.workspace.getLeavesOfType(viewType)[0];
        if (!leaf) return null;
        return {
            viewType: leaf.view.getViewType(),
            // Before the plugin loads, Obsidian keeps the leaf with a placeholder view that only remembers the type.
            rendered: leaf.view.containerEl.querySelector(".notebook-navigator") !== null,
            visible: (leaf as unknown as { isVisible(): boolean }).isVisible(),
        };
    }, notebookNavigatorViewType);
}

/**
 * A lazy plugin's sidebar view restored while the sidebar was collapsed stays a placeholder,
 * and expanding the sidebar fires no active-leaf-change. Expanding it must still load the plugin
 * so the placeholder is replaced by the real view.
 */
test("expanding a collapsed sidebar loads the lazy plugin behind its restored view", async ({ obsidian }) => {
    // Notebook Navigator opens its view in the left sidebar on first launch.
    await obsidian.waitForPluginLoaded(notebookNavigatorId);
    await obsidian.waitForViewType(notebookNavigatorViewType);

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const viewTypes = await withReloadRecorded(obsidian, () =>
        pluginHandle.evaluate(async (plugin: OnDemandPlugin, pluginId) => {
            await plugin.updatePluginSettings(pluginId, "lazy");
            plugin.settings.plugins[pluginId].lazyOptions = { useView: true, viewTypes: [], useFile: false, fileCriteria: {} };
            await plugin.saveSettings();
            await plugin.applyStartupPolicyAndRestart([pluginId]);
            return plugin.settings.plugins[pluginId].lazyOptions?.viewTypes ?? [];
        }, notebookNavigatorId),
    );
    expect(viewTypes).toContain(notebookNavigatorViewType);

    await obsidian.page.evaluate(() => {
        // The first-launch welcome modal would otherwise stay over the workspace.
        document.querySelectorAll<HTMLElement>(".modal-close-button").forEach((button) => button.click());
        app.workspace.leftSplit.collapse();
    });

    // Only the plugin under test loads at startup; Notebook Navigator stays lazy.
    await obsidian.reload({ expectLoaded: [pluginUnderTestId] });
    expect(await obsidian.isPluginLoaded(notebookNavigatorId)).toBe(false);
    expect(await readNavigatorLeaf(obsidian)).toEqual({ viewType: notebookNavigatorViewType, rendered: false, visible: false });

    await obsidian.page.evaluate(() => app.workspace.leftSplit.expand());

    await obsidian.waitForPluginLoaded(notebookNavigatorId);
    await expect.poll(() => readNavigatorLeaf(obsidian)).toEqual({ viewType: notebookNavigatorViewType, rendered: true, visible: true });
});
