import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCoverageReport, resetCoverageOutput } from "obsidian-e2e-toolkit/coverage";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "coverage/e2e");

function run(script, args = [], coverage = true) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: root,
            env: { ...process.env, E2E_COVERAGE: coverage ? "1" : "0" },
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) reject(new Error(`Child process terminated by ${signal}`));
            else resolve(code ?? 1);
        });
    });
}

await resetCoverageOutput(outputDir);
const buildExit = await run(path.join(root, "esbuild.config.mjs"), ["production"]);
if (buildExit) process.exit(buildExit);

let exitCode;
try {
    const args = process.argv.slice(2);
    const cli = path.join(root, "node_modules/@playwright/test/cli.js");
    exitCode = await run(cli, ["test", ...args, "--grep-invert", "@serial", "--pass-with-no-tests"]);
    if (!exitCode) exitCode = await run(cli, ["test", ...args, "--grep", "@serial", "--workers=1", "--pass-with-no-tests"]);
    // Keep both invocations' results and report failing tests too.
    await generateCoverageReport({ outputDir });
} finally {
    // Leave the normal release build in place after coverage collection.
    const restoreExit = await run(path.join(root, "esbuild.config.mjs"), ["production"], false);
    if (restoreExit) process.exitCode = restoreExit;
}
process.exitCode ||= exitCode;
