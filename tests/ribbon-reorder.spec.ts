import { expect, test, type ObsidianAPI } from "obsidian-e2e-toolkit";
import type OnDemandPlugin from "src/main";
import { ensureBuilt, pluginUnderTestId, readCommunityPlugins, useOnDemandPluginOnly } from "./test-utils";

useOnDemandPluginOnly();

const fixtureId = "ribbon-order-fixture";
const titles = ["Ribbon fixture first", "Ribbon fixture hidden", "Ribbon fixture last"];
const ids = titles.map((title) => `${fixtureId}:${title}`);

async function readRibbon(obsidian: ObsidianAPI) {
    return obsidian.page.evaluate((fixtureId) => {
        const ribbon = app.workspace.leftRibbon;
        const targetItems = ribbon.items.filter((item) => item.id.startsWith(`${fixtureId}:`));
        const children = Array.from(ribbon.ribbonItemsEl?.children ?? []);
        const visibleOrder = children.flatMap((button) => {
            const item = targetItems.find((item) => item.buttonEl === button);
            return item && getComputedStyle(button).display !== "none" ? [item.id] : [];
        });
        return {
            visibleOrder,
            hidden: Object.fromEntries(targetItems.map((item) => [item.id, item.hidden])),
            activeIds: targetItems.filter((item) => item.buttonEl?.isConnected).map((item) => item.id),
            // Count rendered DOM too, detecting orphaned placeholders no longer in items.
            domCount: children.filter((button) => button.getAttribute("aria-label")?.startsWith("Ribbon fixture ")).length,
        };
    }, fixtureId);
}

const reloadCases = [false, true].flatMap((useRibbon) => [false, true].map((saveReload) => ({ useRibbon, saveReload })));

for (const { useRibbon, saveReload } of reloadCases) {
    test(`PR #2: ribbon preferences survive lazy loading (useRibbon=${useRibbon}, reload=${saveReload ? "saved" : "in-memory"})`, async ({ obsidian }) => {
        if (!ensureBuilt()) return;
        await obsidian.waitReady();
        const plugin = await obsidian.plugin(pluginUnderTestId);

        // A tiny plugin in the isolated vault makes order/visibility independent of external releases.
        await obsidian.page.evaluate(
            async ({ fixtureId, titles }) => {
                const dir = `${app.vault.configDir}/plugins/${fixtureId}`;
                await app.vault.adapter.mkdir(dir);
                await app.vault.adapter.write(
                    `${dir}/manifest.json`,
                    JSON.stringify({
                        id: fixtureId,
                        name: "Ribbon order fixture",
                        version: "1.0.0",
                        minAppVersion: "1.0.0",
                        description: "Ribbon regression fixture",
                        author: "On-Demand Plugins tests",
                        isDesktopOnly: false,
                    }),
                );
                await app.vault.adapter.write(
                    `${dir}/main.js`,
                    `
                module.exports = class extends require("obsidian").Plugin {
                    onload() {
                        this.clicks = 0;
                        this.commandsRun = 0;
                        for (const title of ${JSON.stringify(titles)}) {
                            this.addRibbonIcon("star", title, () => { this.clicks++; });
                        }
                        this.addCommand({ id: "ping", name: "Ping", callback: () => { this.commandsRun++; } });
                    }
                };
            `,
                );
                await (app.plugins as unknown as { loadManifests(): Promise<void> }).loadManifests();
            },
            { fixtureId, titles },
        );

        await plugin.evaluate(
            async (plugin: OnDemandPlugin, { fixtureId, useRibbon }) => {
                plugin.updateManifests();
                plugin.settings.plugins[fixtureId] = {
                    mode: "lazy",
                    userConfigured: true,
                    lazyOptions: { useRibbon, useView: false, viewTypes: [], useFile: false, fileCriteria: {} },
                };
                await plugin.updatePluginSettings(fixtureId, "lazy");
                // Exercise Apply capture as well as the initially valid command cache.
                const execute = app.commands.executeCommandById;
                app.commands.executeCommandById = () => true;
                try {
                    await plugin.applyStartupPolicyAndRestart([fixtureId]);
                } finally {
                    app.commands.executeCommandById = execute;
                }
                await app.plugins.disablePlugin(fixtureId);
            },
            { fixtureId, useRibbon },
        );

        // Use Obsidian's own layout loader: key order is the user's ribbon order.
        await obsidian.page.evaluate((ids) => {
            const ribbon = app.workspace.leftRibbon;
            const saved = ribbon.serialize().hiddenItems;
            const custom = { [ids[2]]: false, [ids[1]]: true, [ids[0]]: false };
            for (const [id, hidden] of Object.entries(saved)) {
                if (!(id in custom)) custom[id] = hidden;
            }
            ribbon.load({ hiddenItems: custom });
            ribbon.onChange(true);
        }, ids);

        const expectedHidden = { [ids[2]]: false, [ids[1]]: true, [ids[0]]: false };
        const assertRestored = async () => {
            // Wait for UI restoration and print capture state if it fails.
            try {
                await expect
                    .poll(() => readRibbon(obsidian))
                    .toEqual({
                        visibleOrder: [ids[2], ids[0]],
                        hidden: expectedHidden,
                        activeIds: [ids[2], ids[1], ids[0]],
                        domCount: 3,
                    });
            } catch (error) {
                console.log(
                    "Ribbon diagnostics",
                    await obsidian.page.evaluate(
                        ({ fixtureId, pluginUnderTestId }) => {
                            const plugin = app.plugins.plugins[pluginUnderTestId] as unknown as OnDemandPlugin;
                            const features = (
                                plugin.features as unknown as {
                                    features: Array<{
                                        ribbonLoader?: {
                                            isEnabled(id: string): boolean;
                                            hasCaptured(id: string): boolean;
                                            disposed: boolean;
                                        };
                                    }>;
                                }
                            ).features;
                            const loader = features.find((feature) => feature.ribbonLoader)?.ribbonLoader;
                            return {
                                layoutReady: app.workspace.layoutReady,
                                pluginSettings: plugin.settings.plugins[fixtureId],
                                registeredManifest: plugin.manifests.find((manifest) => manifest.id === fixtureId),
                                cache: window.localStorage.getItem(`on-demand:ribbonCache:${app.appId}`),
                                targetLoaded: Boolean(app.plugins.plugins[fixtureId]?._loaded),
                                loader: loader ? { enabled: loader.isEnabled(fixtureId), captured: loader.hasCaptured(fixtureId), disposed: loader.disposed } : null,
                            };
                        },
                        { fixtureId, pluginUnderTestId },
                    ),
                );
                throw error;
            }
        };

        if (useRibbon) await assertRestored();

        // Native *AndSave calls schedule a debounced write rather than await it.
        // Let the setup's pending save settle before taking the disk baseline.
        await expect.poll(() => readCommunityPlugins(obsidian)).toEqual([pluginUnderTestId]);
        const savedBefore = await readCommunityPlugins(obsidian);
        const enable = async (id: string) => {
            await obsidian.page.evaluate(
                async ({ id, saveReload }) => {
                    if (saveReload) await app.plugins.enablePluginAndSave(id);
                    else await app.plugins.enablePlugin(id);
                },
                { id, saveReload },
            );
        };
        const disable = async (id: string) => {
            await obsidian.page.evaluate(
                async ({ id, saveReload }) => {
                    if (saveReload) await app.plugins.disablePluginAndSave(id);
                    else await app.plugins.disablePlugin(id);
                },
                { id, saveReload },
            );
        };

        // Reload the target while it is running, through the actual native methods.
        await enable(fixtureId);
        await assertRestored();
        if (saveReload) await expect.poll(() => readCommunityPlugins(obsidian)).toContain(fixtureId);
        else expect(await readCommunityPlugins(obsidian)).toEqual(savedBefore);
        await disable(fixtureId);
        expect(await obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), fixtureId)).toBe(false);
        if (useRibbon) await assertRestored();
        else expect((await readRibbon(obsidian)).domCount).toBe(0);
        await enable(fixtureId);
        await assertRestored();
        await obsidian.page.locator(`.side-dock-ribbon-action[aria-label="${titles[0]}"]`).click();
        expect(await obsidian.page.evaluate((id) => (app.plugins.plugins[id] as unknown as { clicks: number }).clicks, fixtureId)).toBe(1);
        await disable(fixtureId);
        if (saveReload) await expect.poll(() => readCommunityPlugins(obsidian)).toEqual(savedBefore);
        else expect(await readCommunityPlugins(obsidian)).toEqual(savedBefore);
        expect(
            await obsidian.page.evaluate(
                ({ fixtureId, pluginUnderTestId }) => {
                    const plugin = app.plugins.plugins[pluginUnderTestId] as unknown as OnDemandPlugin;
                    return plugin.settings.plugins[fixtureId];
                },
                { fixtureId, pluginUnderTestId },
            ),
        ).toMatchObject({ mode: "lazy", lazyOptions: { useRibbon } });

        // Re-register the lazy engine as at startup, with inactive saved ribbon entries.
        await disable(pluginUnderTestId);
        expect((await readRibbon(obsidian)).domCount).toBe(0);
        if (saveReload) await expect.poll(() => readCommunityPlugins(obsidian)).not.toContain(pluginUnderTestId);
        else expect(await readCommunityPlugins(obsidian)).toEqual(savedBefore);
        await enable(pluginUnderTestId);
        if (saveReload) await expect.poll(() => readCommunityPlugins(obsidian)).toEqual(savedBefore);
        else expect(await readCommunityPlugins(obsidian)).toEqual(savedBefore);
        expect(await obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), fixtureId)).toBe(false);
        if (useRibbon) await assertRestored();
        else expect((await readRibbon(obsidian)).domCount).toBe(0);

        if (useRibbon) {
            // Full restart must also restore preferences when there are no live plugin icons.
            await obsidian.page.evaluate(() => app.workspace.saveLayout());
            if (saveReload) {
                // Run the Save + Apply reload command, rather than simulating it with page.reload.
                const navigation = obsidian.page.waitForEvent("domcontentloaded");
                try {
                    await obsidian.page.evaluate(
                        async ({ fixtureId, pluginUnderTestId }) => {
                            const plugin = app.plugins.plugins[pluginUnderTestId] as unknown as OnDemandPlugin;
                            await plugin.saveSettings();
                            await plugin.applyStartupPolicyAndRestart([fixtureId]);
                        },
                        { fixtureId, pluginUnderTestId },
                    );
                } catch (error) {
                    // The real reload may destroy evaluate's context before it settles.
                    if (!String(error).includes("Execution context was destroyed")) throw error;
                }
                await navigation;
            } else {
                await obsidian.page.reload();
            }
            await obsidian.waitReady();
            expect(await obsidian.page.evaluate((id) => Boolean(app.plugins.plugins[id]?._loaded), fixtureId)).toBe(false);
            await assertRestored();
            expect(await readCommunityPlugins(obsidian)).toEqual(savedBefore);
        }

        for (let cycle = 0; cycle < 2; cycle++) {
            if (useRibbon) {
                await obsidian.page.locator(`.side-dock-ribbon-action[aria-label="${titles[0]}"]`).click();
                await expect
                    .poll(() =>
                        obsidian.page.evaluate((id) => {
                            const target = app.plugins.plugins[id] as (typeof app.plugins.plugins)[string] & { clicks?: number };
                            return target?.clicks ?? 0;
                        }, fixtureId),
                    )
                    .toBe(1);
            } else {
                await obsidian.command(`${fixtureId}:ping`);
                await expect
                    .poll(() =>
                        obsidian.page.evaluate((id) => {
                            const target = app.plugins.plugins[id] as (typeof app.plugins.plugins)[string] & { commandsRun?: number };
                            return target?.commandsRun ?? 0;
                        }, fixtureId),
                    )
                    .toBe(1);
            }
            await assertRestored();
            await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), fixtureId);
            if (useRibbon) await assertRestored();
            else expect((await readRibbon(obsidian)).domCount).toBe(0);
        }

        // Engine unload must detach placeholders without discarding the user's preferences.
        if (useRibbon) {
            await obsidian.page.evaluate((id) => app.plugins.disablePlugin(id), pluginUnderTestId);
            const unloaded = await readRibbon(obsidian);
            expect(unloaded.domCount).toBe(0);
            expect(unloaded.hidden).toEqual(expectedHidden);
        }
    });
}
