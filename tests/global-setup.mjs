import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePlugins } from "obsidian-e2e-toolkit";

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Anchor fixture setup to this file so Playwright, pnpm, and CI all prepare plugins
// in the same repo-local myfiles directory that the tests later mount.
const repoRoot = path.resolve(__dirname, "..");
const pluginSourcesPath = path.resolve(repoRoot, "tests", "plugin-sources.json");

/**
 * Utility to check if a file or directory exists asynchronously.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Helper to execute shell commands while preserving stderr in failures.
 * @param {string} command - Command to run.
 * @param {string[]} args - Command arguments.
 * @param {string} cwd - Working directory.
 * @param {string} label - Context label for logging.
 */
async function runCommand(command, args, cwd, label) {
    try {
        await execFileP(command, args, { cwd });
    } catch (err) {
        const details = [err?.message, err?.stdout, err?.stderr].filter((value) => typeof value === "string" && value.length > 0).join("\n");

        throw new Error(`[global-setup] ${label} failed: ${details || err}`);
    }
}

/**
 * Reads the plugin mapping. A missing or broken file stops the run, because every
 * spec that mounts a fixture plugin would otherwise fail with a less precise error.
 * @returns {Promise<Record<string, string | { repo: string, tag?: string }>>}
 */
async function readPluginSources() {
    let content;
    try {
        content = await readFile(pluginSourcesPath, "utf8");
    } catch (err) {
        throw new Error(`[global-setup] cannot read ${pluginSourcesPath}: ${err.message}`);
    }

    try {
        return JSON.parse(content);
    } catch (err) {
        throw new Error(`[global-setup] ${pluginSourcesPath} is not valid JSON: ${err.message}`);
    }
}

/**
 * Main global setup function for Playwright/E2E testing.
 */
export default async function globalSetup() {
    // 1. Ensure the main project is built. Only this repo's own main.js is built here;
    // the external fixture plugins are fetched by the toolkit below.
    const mainJsPath = path.resolve(repoRoot, "main.js");
    // Invoke the build entry directly so Windows does not need to execute pnpm.cmd.
    // Rebuild every run: an existing main.js may belong to an older source tree.
    await runCommand(process.execPath, [path.join(repoRoot, "esbuild.config.mjs"), "production"], repoRoot, "main build");

    if (!(await fileExists(mainJsPath))) {
        throw new Error(`[global-setup] ${mainJsPath} not found after build`);
    }

    // 2. Place the external fixture plugins into tests' myfiles folder. preparePlugins
    // throws one error that lists every failed plugin, so no spec starts with a partial set.
    await preparePlugins(await readPluginSources(), repoRoot);
}
