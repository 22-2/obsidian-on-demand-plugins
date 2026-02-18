import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    timeout: 300_000,
    expect: { timeout: 5_000 },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        headless: true,
        trace: "on-first-retry",
    },
    globalSetup: "./tests/global-setup.mjs",
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
