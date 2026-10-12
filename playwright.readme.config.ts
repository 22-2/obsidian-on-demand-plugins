import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// README screenshots live outside tests/, so the regular e2e run does not pick them up.
export default defineConfig({
    ...base,
    testDir: "./scripts/readme",
});
