import { defineObsidianConfig } from "obsidian-e2e-toolkit";
import base from "./playwright.config";

// README screenshots live outside tests/, so the regular e2e run does not pick them up.
export default defineObsidianConfig({
    ...base,
    testDir: "./scripts/readme",
});