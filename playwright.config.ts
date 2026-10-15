import { devices } from "@playwright/test";
import { defineObsidianConfig } from "obsidian-e2e-toolkit";

export default defineObsidianConfig({
    testDir: "./tests",

    // README screenshots are an on-demand asset capture (`pnpm ui:shots:readme`), not a regression test.
    testIgnore: "readme-screenshots.spec.ts",

    timeout: 1_000 * 60 * 2,

    expect: { timeout: 5_000 },

    // Each test launches its own Obsidian instance with an isolated vault, so run them in parallel.
    // CI Windows runners have 4 vCPUs and can take three. The 3-vCPU macOS runner slows down with three,
    // so it keeps two, as does a local machine.
    workers: process.env.CI && process.platform === "win32" ? 3 : 2,

    // On CI, retry up to 3 times: Windows workers have exited unexpectedly between tests (exit code 3221226505) with no assertion failure.
    retries: process.env.CI ? 3 : 0,

    reporter: [["list"], ["html", { open: "never" }]],

    use: {
        headless: true,
    },

    globalSetup: "./tests/global-setup.mjs",

    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});