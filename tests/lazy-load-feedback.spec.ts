import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, useOnDemandPluginOnly } from "./test-utils";

useOnDemandPluginOnly();

const fixtureId = "slow-load-fixture";
const fixtureName = "Slow load fixture";
const commandId = `${fixtureId}:mark`;
const viewType = "slow-load-fixture-view";

/** Install a plugin whose onload takes a while, so the lazy-loading gap is observable. */
async function installSlowFixture(obsidian: ObsidianAPI) {
    await obsidian.page.evaluate(
        async ({ id, name, viewType }) => {
            const dir = `${app.vault.configDir}/plugins/${id}`;
            await app.vault.adapter.mkdir(dir);
            await app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify({ id, name, version: "1.0.0", minAppVersion: "1.0.0", description: "Loads slowly.", author: "E2E", isDesktopOnly: false }));
            await app.vault.adapter.write(
                `${dir}/main.js`,
                `
                const { ItemView, Plugin } = require("obsidian");
                class FixtureView extends ItemView {
                    getViewType() { return ${JSON.stringify(viewType)}; }
                    getDisplayText() { return "Fixture view"; }
                    async onOpen() { this.contentEl.createDiv({ cls: "slow-load-fixture-content", text: "ready" }); }
                }
                module.exports = class extends Plugin {
                    async onload() {
                        // Plugins commonly await their settings or an index before registering anything.
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        this.registerView(${JSON.stringify(viewType)}, (leaf) => new FixtureView(leaf));
                        this.addCommand({ id: "mark", name: "Mark", callback: () => { window.__slowFixtureRan = true; } });
                    }
                };
            `,
            );
            await (app.plugins as unknown as { loadManifests: () => Promise<void> }).loadManifests();
        },
        { id: fixtureId, name: fixtureName, viewType },
    );

    const plugin = await obsidian.plugin(pluginUnderTestId);
    await plugin.evaluate(
        async (instance, { id, viewType }) => {
            instance.updateManifests();
            await instance.updatePluginSettings(id, "lazy");
            instance.core.settingsService.activeProfile.settings.plugins[id].lazyOptions = { useView: true, viewTypes: [viewType], useFile: false, fileCriteria: {} };
            instance.core.settingsService.activeProfile.settings.lazyOnViews = { ...instance.core.settingsService.activeProfile.settings.lazyOnViews, [id]: [viewType] };
            await instance.saveSettings();
        },
        { id: fixtureId, viewType },
    );
    await expect.poll(() => obsidian.isPluginLoaded(fixtureId)).toBe(false);
}

/** Record every notice text and whether a loading overlay ever appeared, from now on. */
async function startRecordingFeedback(obsidian: ObsidianAPI) {
    await obsidian.page.evaluate(() => {
        const record = { notices: [] as string[], sawOverlay: false };
        (window as unknown as { __feedback: typeof record }).__feedback = record;
        const capture = () => {
            document.querySelectorAll(".notice").forEach((el) => {
                const text = el.textContent ?? "";
                if (record.notices.at(-1) !== text) record.notices.push(text);
            });
            if (document.querySelector(".lazy-plugin-view-loading")) record.sawOverlay = true;
        };
        new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

function readFeedback(obsidian: ObsidianAPI) {
    return obsidian.page.evaluate(() => (window as unknown as { __feedback: { notices: string[]; sawOverlay: boolean } }).__feedback);
}

test("a lazy command shows a loading notice and then reports the result", async ({ obsidian }) => {
    await installSlowFixture(obsidian);
    await startRecordingFeedback(obsidian);

    await obsidian.page.evaluate((id) => app.commands.executeCommandById(id), commandId);

    await expect.poll(() => obsidian.page.evaluate(() => Boolean((window as unknown as { __slowFixtureRan?: boolean }).__slowFixtureRan))).toBe(true);
    await expect.poll(async () => (await readFeedback(obsidian)).notices).toEqual([`Loading ${fixtureName}…`, `${fixtureName} loaded`]);
});

test("a leaf waiting for its lazy view shows a spinner until the view replaces it", async ({ obsidian }) => {
    await installSlowFixture(obsidian);
    await startRecordingFeedback(obsidian);

    await obsidian.page.evaluate(async (viewType) => {
        await app.workspace.getLeaf("tab").setViewState({ type: viewType, active: true });
    }, viewType);

    await obsidian.waitForPluginLoaded(fixtureId);
    await expect
        .poll(() =>
            obsidian.page.evaluate((viewType) => {
                const leaf = app.workspace.getLeavesOfType(viewType)[0];
                return {
                    rendered: leaf?.view.containerEl.querySelector(".slow-load-fixture-content") !== null,
                    overlay: document.querySelector(".lazy-plugin-view-loading") !== null,
                };
            }, viewType),
        )
        .toEqual({ rendered: true, overlay: false });
    expect((await readFeedback(obsidian)).sawOverlay).toBe(true);
});
