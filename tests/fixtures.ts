import { expect, test as base } from "obsidian-e2e-toolkit";

// Define defaults on the shared test type so every spec gets coverage settings.
export const test = base.extend({
    coverageOptions: {
        enabled: process.env.E2E_COVERAGE === "1",
        pluginPaths: [process.cwd()],
        outputDir: "coverage/e2e",
    },
});

export { expect };
