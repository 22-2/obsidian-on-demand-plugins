import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { createE2ECoverageMap } from "./e2e-coverage-report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "coverage/e2e");
const bundlePath = path.join(root, "main.js");

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

async function generateReport() {
    const bundle = await readFile(bundlePath, "utf8");
    const collected = [];
    for (const filename of await readdir(path.join(directory, "raw"))) {
        const entries = JSON.parse(await readFile(path.join(directory, "raw", filename), "utf8"));
        collected.push(...entries);
    }
    if (!collected.length) throw new Error("No plugin coverage collected. Run an E2E test that loads on-demand-plugins.");
    const coverageMap = await createE2ECoverageMap(bundle, collected, bundlePath);
    const context = libReport.createContext({ dir: directory, coverageMap });
    for (const format of ["text", "html", "lcovonly", "json"]) reports.create(format).execute(context);
}

// Only remove this script's fixed, repository-local output directory.
await rm(directory, { recursive: true, force: true });
await mkdir(path.join(directory, "raw"), { recursive: true });
const buildExit = await run(path.join(root, "esbuild.config.mjs"), ["production"]);
if (buildExit) process.exit(buildExit);

let exitCode;
try {
    const args = process.argv.slice(2);
    const cli = path.join(root, "node_modules/@playwright/test/cli.js");
    exitCode = await run(cli, ["test", ...args, "--grep-invert", "@serial", "--pass-with-no-tests"]);
    if (!exitCode) exitCode = await run(cli, ["test", ...args, "--grep", "@serial", "--workers=1", "--pass-with-no-tests"]);
    // Keep both Playwright invocations' raw data and report failures too.
    await generateReport();
} finally {
    // Leave the normal release build in place after coverage collection.
    const restoreExit = await run(path.join(root, "esbuild.config.mjs"), ["production"], false);
    if (restoreExit) process.exitCode = restoreExit;
}
process.exitCode ||= exitCode;
