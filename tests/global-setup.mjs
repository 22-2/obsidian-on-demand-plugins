import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * @typedef {{ repo: string, tag?: string }} PluginSource
 */

/**
 * Normalizes legacy string entries and new tagged entries to one shape.
 * @param {string | PluginSource} source
 * @returns {PluginSource}
 */
function normalizePluginSource(source) {
    if (typeof source === "string") {
        return { repo: source };
    }

    if (!source || typeof source.repo !== "string" || source.repo.length === 0) {
        throw new TypeError("plugin source must be a repo string or an object with a repo field");
    }

    return { repo: source.repo, tag: source.tag };
}

/**
 * Parses a GitHub owner/repo identifier.
 * @param {string} ownerRepo
 * @returns {{ owner: string, repo: string }}
 */
function parseOwnerRepo(ownerRepo) {
    const [owner, repo] = ownerRepo.split("/");
    if (!owner || !repo) {
        throw new TypeError(`invalid GitHub repo identifier: ${ownerRepo}`);
    }

    return { owner, repo };
}

/**
 * Downloads the standard Obsidian release assets for an explicit release tag.
 * @param {PluginSource} source
 * @param {string} dest
 */
async function fetchTaggedRelease(source, dest) {
    const { owner, repo } = parseOwnerRepo(source.repo);
    const releaseApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${source.tag}`;
    const response = await fetch(releaseApiUrl, {
        headers: {
            "User-Agent": "obsidian-lazy-plugins-tests"
        }
    });

    if (!response.ok) {
        throw new Error(`failed to resolve release ${source.tag} for ${source.repo}: ${response.status}`);
    }

    /** @type {{ assets?: Array<{ name?: string, browser_download_url?: string }> }} */
    const release = await response.json();
    const desiredFiles = ["main.js", "manifest.json", "styles.css"];

    await mkdir(dest, { recursive: true });

    for (const fileName of desiredFiles) {
        const asset = release.assets?.find((entry) => entry.name === fileName);
        if (!asset?.browser_download_url) {
            continue;
        }

        const assetResponse = await fetch(asset.browser_download_url, {
            headers: {
                "User-Agent": "obsidian-lazy-plugins-tests"
            }
        });
        if (!assetResponse.ok) {
            throw new Error(`failed to download ${fileName} for ${source.repo}@${source.tag}: ${assetResponse.status}`);
        }

        const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
        await writeFile(path.join(dest, fileName), assetBuffer);
    }
}

/**
 * Reads the cache marker so a pinned tag change invalidates a stale plugin copy.
 * @param {string} metadataPath
 * @returns {Promise<PluginSource | null>}
 */
async function readCachedPluginSource(metadataPath) {
    if (!(await fileExists(metadataPath))) {
        return null;
    }

    try {
        const content = await readFile(metadataPath, "utf8");
        return normalizePluginSource(JSON.parse(content));
    } catch {
        return null;
    }
}

/**
 * @param {PluginSource} source
 * @param {PluginSource | null} cachedSource
 * @param {string} manifestPath
 * @returns {Promise<boolean>}
 */
async function shouldRefreshPlugin(source, cachedSource, manifestPath) {
    if (!(await fileExists(manifestPath))) {
        return true;
    }

    if (!cachedSource) {
        return true;
    }

    return cachedSource.repo !== source.repo || (cachedSource.tag ?? "") !== (source.tag ?? "");
}

/**
 * Handles the fetch, install, and build process for a single plugin.
 * @param {string} pluginId
 * @param {string | PluginSource} sourceValue
 * @param {string} baseDir
 */
async function setupExternalPlugin(pluginId, sourceValue, baseDir) {
    const source = normalizePluginSource(sourceValue);
    const dest = path.resolve(baseDir, "myfiles", pluginId);
    const manifestPath = path.join(dest, "manifest.json");
    const pkgPath = path.join(dest, "package.json");
    const metadataPath = path.join(dest, ".lazy-plugin-source.json");

    try {
        const cachedSource = await readCachedPluginSource(metadataPath);
        const refreshRequired = await shouldRefreshPlugin(source, cachedSource, manifestPath);

        if (!refreshRequired) {
            console.log(`[global-setup] ${pluginId} already cached at ${source.tag ?? "latest"}, skipping fetch`);
        } else {
            // Recreate the cache when the pinned source changes so tests never mix old plugin files with a new tag.
            await rm(dest, { recursive: true, force: true });

            console.log(`[global-setup] fetching ${source.repo}${source.tag ? `@${source.tag}` : ""} -> ${dest}`);
            if (source.tag) {
                await fetchTaggedRelease(source, dest);
            } else {
                await fetchPlugin(`https://github.com/${source.repo}.git`, dest);
            }

            await writeFile(metadataPath, `${JSON.stringify(source, null, 4)}\n`, "utf8");
        }

        // Run build steps if package.json is present
        if (await fileExists(pkgPath)) {
            console.log(`[global-setup] installing/building plugin: ${pluginId}`);
            await runSafeCommand("pnpm install --silent", dest, `pnpm install (${pluginId})`);
            await runSafeCommand("pnpm run build --silent", dest, `pnpm build (${pluginId})`);
        }
    } catch (err) {
        console.warn(`[global-setup] Error processing ${pluginId} (${source.repo}):`, err?.message || err);
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
    for (const [pluginId, source] of Object.entries(repoMap)) {
        await setupExternalPlugin(pluginId, source, repoRoot);
    }
}
