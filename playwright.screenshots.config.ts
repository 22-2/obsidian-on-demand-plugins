import { defineObsidianConfig } from "obsidian-e2e-toolkit";
import base from "./playwright.config";

// The README profile has its own spec and output; the regular e2e run skips it (see playwright.config.ts).
const specFile = process.env.UI_SCREENSHOT_DEVICE === "readme" ? "readme-screenshots.spec.ts" : "ui-screenshots.spec.ts";

export default defineObsidianConfig({
    ...base,
    testDir: "./tests",
    testMatch: specFile,
    testIgnore: [],
    workers: 1,
});
