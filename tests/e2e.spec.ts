import { expect, test } from "./fixtures";

test("smoke: vault ready", async ({ obsidian }) => {
    await obsidian.waitReady();
    expect(await obsidian.vaultName()).toBeTruthy();
});
