import { defineConfig, devices } from "@playwright/test";

if (process.platform === "linux") {
    throw new Error("Playwright tests are not supported on Linux due to a known issue with electron.launch on Ubuntu GitHub Actions. Please run the tests on macOS or Windows instead.");
    // [[BUG] electron.launch: Process failed to launch on Ubuntu github action · Issue #11932 · microsoft/playwright](https://github.com/microsoft/playwright/issues/11932)
}

export default defineConfig({
    testDir: "./tests",

    timeout: 1_000 * 60 * 2,

    expect: { timeout: 5_000 },

    // Each test launches its own Obsidian instance with an isolated vault, so run two in parallel everywhere.
    workers: 2,

    // On CI, retry up to 3 times: Windows workers have exited unexpectedly between tests (exit code 3221226505) with no assertion failure.
    retries: process.env.CI ? 3 : 0,

    reporter: [["list"], ["html", { open: "never" }]],

    use: {
        headless: true,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },

    globalSetup: "./tests/global-setup.mjs",

    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
