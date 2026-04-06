import { defineConfig, devices } from "@playwright/test";

if (process.platform === "linux") {
    throw new Error("Playwright tests are not supported on Linux due to a known issue with electron.launch on Ubuntu GitHub Actions. Please run the tests on macOS or Windows instead.");
    // [[BUG] electron.launch: Process failed to launch on Ubuntu github action · Issue #11932 · microsoft/playwright](https://github.com/microsoft/playwright/issues/11932)
}

export default defineConfig({
    testDir: "./tests",

    timeout: 1_000 * 60 * 2,

    expect: { timeout: 5_000 },

    workers: process.env.CI ? 1 : undefined,

    reporter: [["list"], ["html", { open: "never" }]],

    use: {
        headless: true,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },

    globalSetup: "./tests/global-setup.mjs",

    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
