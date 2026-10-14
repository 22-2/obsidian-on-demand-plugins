import { defineObsidianConfig } from "obsidian-e2e-toolkit";
import base from "./playwright.config";

export default defineObsidianConfig({
    ...base,
    testDir: "./tests",
    testMatch: "ui-screenshots.spec.ts",
    workers: 1,
});
