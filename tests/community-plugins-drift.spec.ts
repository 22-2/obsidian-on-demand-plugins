import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ObsidianAPI } from "obsidian-e2e-toolkit";
import { expect, test } from "./fixtures";
import { pluginUnderTestId, useVaultPlugins, withReloadRecorded } from "./test-utils";

// Dozens of minimal plugins so bulk toggles and rewrites run against real Obsidian.
const fixtureRoot = path.join(os.tmpdir(), "on-demand-drift-fixtures");
const dummyIds = Array.from({ length: 30 }, (_, i) => `drift-dummy-${String(i).padStart(2, "0")}`);
for (const id of dummyIds) {
    const dir = path.join(fixtureRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, name: `Drift ${id.slice(-2)}`, version: "1.0.0", minAppVersion: "1.0.0", description: "E2E fixture", author: "e2e" }));
    writeFileSync(path.join(dir, "main.js"), `const { Plugin } = require("obsidian");\nmodule.exports = class extends Plugin { onload() { this.addCommand({ id: "ping", name: "Ping", callback: () => {} }); } };\n`);
}

useVaultPlugins([path.resolve(import.meta.dirname, ".."), ...dummyIds.map((id) => path.join(fixtureRoot, id))]);

const initiallyEnabled = dummyIds.slice(0, 15);
const initiallyDisabled = dummyIds.slice(15);

type DriftResult = { enabledExternally: string[]; disabledExternally: string[]; selfMissing: boolean } | null;

/** Saves modes and the matching community-plugins.json, then restarts so Obsidian and On-Demand start from that state. */
async function startFrom(obsidian: ObsidianAPI) {
    const desired = [pluginUnderTestId, ...initiallyEnabled].sort();
    await obsidian.page.evaluate(
        async ({ enabled, disabled, desired }) => {
            const plugin = app.plugins.plugins["on-demand-plugins"] as unknown as {
                settings: { plugins: Record<string, { mode: string; userConfigured: boolean }> };
                saveSettings: () => Promise<void>;
            };
            for (const id of enabled) plugin.settings.plugins[id] = { mode: "alwaysEnabled", userConfigured: true };
            for (const id of disabled) plugin.settings.plugins[id] = { mode: "alwaysDisabled", userConfigured: true };
            await plugin.saveSettings();
            app.plugins.enabledPlugins = new Set(desired);
            await app.vault.writeConfigJson("community-plugins", desired);
        },
        { enabled: initiallyEnabled, disabled: initiallyDisabled, desired },
    );
    await obsidian.reload({ expectLoaded: desired });
    expect(await onDiskSorted(obsidian)).toEqual(desired);
}

function modesOf(obsidian: ObsidianAPI, ids: string[]) {
    return obsidian.page.evaluate((pluginIds) => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as unknown as { getPluginMode: (id: string) => string };
        return pluginIds.map((id) => plugin.getPluginMode(id));
    }, ids);
}

function detectDrift(obsidian: ObsidianAPI): Promise<DriftResult> {
    return obsidian.page.evaluate(async () => {
        const plugin = app.plugins.plugins["on-demand-plugins"] as unknown as { features: { features: { detect?: () => Promise<unknown> }[] } };
        const feature = plugin.features.features.find((candidate) => typeof candidate.detect === "function");
        return (await feature!.detect!()) as DriftResult;
    });
}

/** Obsidian keeps insertion order, so compare the file as a sorted list. */
const onDiskSorted = async (obsidian: ObsidianAPI) => (await obsidian.enabledPluginsOnDisk()).slice().sort();

const driftNotice = (obsidian: ObsidianAPI) => obsidian.page.locator(".notice").filter({ hasText: "changed outside On-Demand Plugins" });

test("restricted mode on and off keeps every saved mode and the file", async ({ obsidian }) => {
    await startFrom(obsidian);

    await obsidian.page.evaluate(async () => {
        await app.plugins.setEnable(false);
        await app.plugins.setEnable(true);
    });
    await obsidian.waitForPluginLoaded(pluginUnderTestId);

    expect(await modesOf(obsidian, initiallyEnabled)).toEqual(initiallyEnabled.map(() => "alwaysEnabled"));
    expect(await modesOf(obsidian, initiallyDisabled)).toEqual(initiallyDisabled.map(() => "alwaysDisabled"));
    expect(await onDiskSorted(obsidian)).toEqual([pluginUnderTestId, ...initiallyEnabled].sort());
    expect(await detectDrift(obsidian)).toBeNull();
    await expect(driftNotice(obsidian)).toHaveCount(0);
});

test("bulk enable and disable through Obsidian's save path are followed, not reported", async ({ obsidian }) => {
    await startFrom(obsidian);

    // The CLI's plugin:enable / plugin:disable and the Community plugins toggles call these methods.
    await obsidian.page.evaluate(async (ids) => {
        await Promise.all(ids.map((id) => app.plugins.enablePluginAndSave(id)));
    }, initiallyDisabled);
    await expect.poll(() => onDiskSorted(obsidian)).toEqual([pluginUnderTestId, ...dummyIds].sort());
    expect(await modesOf(obsidian, initiallyDisabled)).toEqual(initiallyDisabled.map(() => "alwaysEnabled"));
    expect(await detectDrift(obsidian)).toBeNull();

    await obsidian.page.evaluate(async (ids) => {
        await Promise.all(ids.map((id) => app.plugins.disablePluginAndSave(id)));
    }, dummyIds);
    await expect.poll(() => onDiskSorted(obsidian)).toEqual([pluginUnderTestId]);
    expect(await modesOf(obsidian, dummyIds)).toEqual(dummyIds.map(() => "alwaysDisabled"));
    expect(await detectDrift(obsidian)).toBeNull();
});

test("an arbitrary external rewrite is reported, kept on cancel and noticed at the next start", async ({ obsidian }) => {
    await startFrom(obsidian);
    // A Sync/Git-style rewrite: flips every other entry and drops On-Demand itself.
    const rewritten = dummyIds.filter((_, i) => i % 2 === 0);
    await obsidian.page.evaluate((ids) => app.vault.writeConfigJson("community-plugins", ids), rewritten);

    const drift = await detectDrift(obsidian);
    expect(drift?.enabledExternally).toEqual(rewritten.filter((id) => !initiallyEnabled.includes(id)));
    expect(drift?.disabledExternally).toEqual(initiallyEnabled.filter((id) => !rewritten.includes(id)));
    expect(drift?.selfMissing).toBe(true);

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    const reload = await obsidian.interceptReload();
    try {
        const applying = pluginHandle.evaluate((plugin: { applyStartupPolicyAndRestart: () => Promise<void> }) => plugin.applyStartupPolicyAndRestart());
        const modal = obsidian.page.locator(".modal").filter({ hasText: "Continuing overwrites these changes" });
        await expect(modal).toContainText("enabled 7");
        await expect(modal).toContainText("removed On-Demand Plugins itself");
        await modal.getByRole("button", { name: "Cancel" }).click();
        await applying;
        expect(await reload.requested()).toBe(false);
    } finally {
        await reload.restore();
    }
    expect(await onDiskSorted(obsidian)).toEqual(rewritten.slice().sort());

    // Put On-Demand back so it loads after the restart, then check the startup notice for the rest.
    await obsidian.page.evaluate((ids) => app.vault.writeConfigJson("community-plugins", ids), [pluginUnderTestId, ...rewritten]);
    await obsidian.page.evaluate((ids) => (app.plugins.enabledPlugins = new Set(ids)), [pluginUnderTestId, ...rewritten]);
    await obsidian.reload({ expectLoaded: [pluginUnderTestId] });
    await expect(driftNotice(obsidian)).toContainText("enabled 7");
    await expect(driftNotice(obsidian)).toContainText("disabled 7");
});

test("applying after the user agrees writes the On-Demand settings back", async ({ obsidian }) => {
    await startFrom(obsidian);
    await obsidian.page.evaluate((ids) => app.vault.writeConfigJson("community-plugins", ids), [pluginUnderTestId, ...dummyIds]);

    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await withReloadRecorded(obsidian, async () => {
        const applying = pluginHandle.evaluate((plugin: { applyStartupPolicyAndRestart: () => Promise<void> }) => plugin.applyStartupPolicyAndRestart());
        const modal = obsidian.page.locator(".modal").filter({ hasText: "Continuing overwrites these changes" });
        await expect(modal).toContainText("enabled 15");
        await modal.getByRole("button", { name: "Yes" }).click();
        await applying;
    });

    expect(await onDiskSorted(obsidian)).toEqual([pluginUnderTestId, ...initiallyEnabled].sort());
    expect(await detectDrift(obsidian)).toBeNull();
});
