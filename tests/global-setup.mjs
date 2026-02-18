import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { fetchPlugin } from "obsidian-e2e-toolkit";

const execP = promisify(exec);

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
 * Helper to execute shell commands with localized error handling.
 * @param {string} command - Command to run.
 * @param {string} cwd - Working directory.
 * @param {string} label - Context label for logging.
 */
async function runSafeCommand(command, cwd, label) {
    try {
        await execP(command, { cwd });
    } catch (err) {
        console.warn(`[global-setup] ${label} failed (ignored):`, err?.message || err);
    }
}

/**
 * Handles the fetch, install, and build process for a single plugin.
 * @param {string} pluginId 
 * @param {string} ownerRepo 
 * @param {string} baseDir 
 */
async function setupExternalPlugin(pluginId, ownerRepo, baseDir) {
    const dest = path.resolve(baseDir, "myfiles", pluginId);
    const manifestPath = path.join(dest, "manifest.json");
    const pkgPath = path.join(dest, "package.json");

    try {
        // Check if the plugin is already cached by looking for manifest.json
        if (await fileExists(manifestPath)) {
            console.log(`[global-setup] ${pluginId} already cached, skipping fetch`);
        } else {
            console.log(`[global-setup] fetching ${ownerRepo} -> ${dest}`);
            await fetchPlugin(`https://github.com/${ownerRepo}.git`, dest);
        }

        // Run build steps if package.json is present
        if (await fileExists(pkgPath)) {
            console.log(`[global-setup] installing/building plugin: ${pluginId}`);
            await runSafeCommand("pnpm install --silent", dest, `pnpm install (${pluginId})`);
            await runSafeCommand("pnpm run build --silent", dest, `pnpm build (${pluginId})`);
        }
    } catch (err) {
        console.warn(`[global-setup] Error processing ${pluginId} (${ownerRepo}):`, err?.message || err);
    }
}

/**
 * Main global setup function for Playwright/E2E testing.
 */
export default async function globalSetup() {
    const repoRoot = process.cwd();

    // 1. Ensure the main project is built
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!(await fileExists(mainJsPath))) {
        console.log("[global-setup] main.js missing, running build:nocheck");
        await runSafeCommand("pnpm run build:nocheck --silent", repoRoot, "main build");
    }

    // 2. Load plugin mapping
    const repoMapPath = path.resolve(repoRoot, "tests", "plugin-sources.json");
    if (!existsSync(repoMapPath)) {
        console.warn("[global-setup] No plugin-sources.json found; skipping external plugins");
        return;
    }

    let repoMap;
    try {
        const content = await readFile(repoMapPath, "utf8");
        repoMap = JSON.parse(content);
    } catch (err) {
        console.error("[global-setup] Failed to parse plugin-sources.json:", err.message);
        return;
    }

    // 3. Process each plugin sequentially to avoid I/O race conditions
    for (const [pluginId, ownerRepo] of Object.entries(repoMap)) {
        await setupExternalPlugin(pluginId, ownerRepo, repoRoot);
    }
}
