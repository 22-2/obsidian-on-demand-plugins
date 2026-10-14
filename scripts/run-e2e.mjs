import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(repoRoot, "node_modules/@playwright/test/cli.js");

export function runNode(script, args = [], env = {}, cwd = repoRoot) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd,
            env: { ...process.env, ...env },
            stdio: "inherit",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) reject(new Error(`Child process terminated by ${signal}`));
            else resolve(code ?? 1);
        });
    });
}

async function readBlobs(directory) {
    try {
        return (await readdir(directory)).filter((name) => name.endsWith(".zip"));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

export async function runE2EPhases(args = [], env = {}, root = repoRoot) {
    // pnpm can forward a leading separator; it must not become a Playwright file filter.
    if (args[0] === "--") args = args.slice(1);
    const blobs = path.resolve(root, "blob-report");
    if (path.dirname(blobs) !== path.resolve(root)) throw new Error("Invalid E2E report directory");
    await rm(blobs, { recursive: true, force: true });

    const phases = [
        { name: "parallel", args: ["--grep-invert", "@serial"] },
        { name: "serial", args: ["--grep", "@serial", "--workers=1"] },
    ];
    let exitCode = 0;
    for (const phase of phases) {
        const result = await runNode(playwrightCli, [
            "test", ...args, ...phase.args,
            "--pass-with-no-tests", "--reporter=list,blob",
            "--output", path.join(root, "test-results", phase.name),
        ], { ...env, PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(blobs, phase.name) }, root);
        // Run both phases and retain a failing result even if the later phase passes.
        exitCode ||= result;
    }

    const merged = path.join(blobs, "combined");
    await mkdir(merged, { recursive: true });
    let count = 0;
    for (const { name } of phases) {
        const phaseDirectory = path.join(blobs, name);
        for (const file of await readBlobs(phaseDirectory)) {
            await copyFile(path.join(phaseDirectory, file), path.join(merged, `${name}-${file}`));
            count++;
        }
    }
    if (count) {
        const mergeExit = await runNode(playwrightCli, ["merge-reports", "--reporter=html,json", merged], {
            ...env,
            PLAYWRIGHT_HTML_OPEN: "never",
            PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(root, "playwright-report"),
            PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(root, "playwright-report", "results.json"),
        }, root);
        exitCode ||= mergeExit;
    }
    return exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = await runE2EPhases(process.argv.slice(2));
}
