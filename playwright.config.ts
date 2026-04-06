import { defineConfig, devices } from "@playwright/test";

// On macOS (darwin), the default timeout is too short and tests become unstable
// (especially in macOS virtual CI environments, where external factors can cause delays),
// so only extend the per-test timeout to 90 seconds on macOS.
const isMac = process.platform === "darwin";

if (process.platform === "linux") {
    throw new Error("Playwright tests are not supported on Linux due to a known issue with electron.launch on Ubuntu GitHub Actions. Please run the tests on macOS or Windows instead.");
    // [[BUG] electron.launch: Process failed to launch on Ubuntu github action · Issue #11932 · microsoft/playwright](https://github.com/microsoft/playwright/issues/11932)
}

export default defineConfig({
    testDir: "./tests",
    timeout: isMac ? 90_000 : 30_000,
    expect: { timeout: 5_000 },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        headless: true,
        trace: "on-first-retry",
    },
    globalSetup: "./tests/global-setup.mjs",
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
