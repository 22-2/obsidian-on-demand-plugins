import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCoverageReport, resetCoverageOutput } from "obsidian-e2e-toolkit/coverage";
import { runE2EPhases, runNode } from "./run-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "coverage/e2e");

await resetCoverageOutput(outputDir);
const buildExit = await runNode(path.join(root, "esbuild.config.mjs"), ["production"], { E2E_COVERAGE: "1" });
if (buildExit) process.exit(buildExit);

let exitCode;
try {
    const args = process.argv.slice(2);
    exitCode = await runE2EPhases(args, { E2E_COVERAGE: "1" });
    // Keep both invocations' results and report failing tests too.
    await generateCoverageReport({ outputDir });
} finally {
    // Leave the normal release build in place after coverage collection.
    const restoreExit = await runNode(path.join(root, "esbuild.config.mjs"), ["production"], { E2E_COVERAGE: "0" });
    if (restoreExit) process.exitCode = restoreExit;
}
process.exitCode ||= exitCode;
