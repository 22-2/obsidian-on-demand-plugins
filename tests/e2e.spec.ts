import { test, expect } from "obsidian-e2e-toolkit";

test("smoke: vault ready", async ({ obsidian }) => {
    await obsidian.waitReady();
    expect(await obsidian.vaultName()).toBeTruthy();
});
