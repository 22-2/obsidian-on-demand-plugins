import { expect, test } from "./fixtures";

test("smoke: vault ready", async ({ obsidian }) => {
    expect(await obsidian.vaultName()).toBeTruthy();
});
