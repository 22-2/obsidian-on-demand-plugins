import path from "node:path";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchPlugin } from "obsidian-e2e-toolkit";

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Anchor fixture setup to this file so Playwright, pnpm, and CI all prepare plugins
// in the same repo-local myfiles directory that the tests later mount.
const repoRoot = path.resolve(__dirname, "..");
const requiredPluginFiles = ["manifest.json", "main.js"];

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
        const details = [err?.message, err?.stdout, err?.stderr]
            .filter((value) => typeof value === "string" && value.length > 0)
            .join("\n");

        throw new Error(`[global-setup] ${label} failed: ${details || err}`);
    }
}

function getGitHubApiHeaders() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const baseHeaders = {
        Accept: "application/vnd.github+json",
        "User-Agent": "obsidian-on-demand-plugins-tests"
    };

    // CI runners share public egress, so authenticated API calls avoid flaky
    // tag lookups when GitHub applies low unauthenticated rate limits.
    return token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;
}

function getGitHubDownloadHeaders() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const baseHeaders = {
        "User-Agent": "obsidian-on-demand-plugins-tests"
    };

    return token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;
}

function getMissingPluginFiles(pluginDir) {
    return requiredPluginFiles.filter((fileName) => !existsSync(path.join(pluginDir, fileName)));
}

function validatePreparedPlugin(pluginId, pluginDir) {
    if (!existsSync(pluginDir)) {
        throw new Error(`[global-setup] ${pluginId} was not downloaded to ${pluginDir}`);
    }

    const missingFiles = getMissingPluginFiles(pluginDir);
    if (missingFiles.length > 0) {
        throw new Error(`[global-setup] ${pluginId} is missing required files: ${missingFiles.join(", ")}`);
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
    const releaseApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(source.tag)}`;
    const response = await fetch(releaseApiUrl, {
        headers: getGitHubApiHeaders()
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
            headers: getGitHubDownloadHeaders()
        });
        if (!assetResponse.ok) {
            throw new Error(`failed to download ${fileName} for ${source.repo}@${source.tag}: ${assetResponse.status}`);
        }

        const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
        await writeFile(path.join(dest, fileName), assetBuffer);
    }
}

async function cloneTaggedPlugin(source, dest, pluginId) {
    await rm(dest, { recursive: true, force: true });

    console.warn(`[global-setup] falling back to git checkout for ${pluginId} at ${source.repo}@${source.tag}`);
    await runCommand(
        "git",
        ["clone", "--depth", "1", "--branch", source.tag, `https://github.com/${source.repo}.git`, dest],
        repoRoot,
        `git clone (${pluginId})`,
    );
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
            try {
                if (source.tag) {
                    await fetchTaggedRelease(source, dest);
                } else {
                    await fetchPlugin(`https://github.com/${source.repo}.git`, dest);
                }
            } catch (err) {
                if (!source.tag) {
                    throw err;
                }

                await cloneTaggedPlugin(source, dest, pluginId);
            }

            if (source.tag && getMissingPluginFiles(dest).length > 0) {
                // Tagged release assets are ideal because they already contain the built plugin,
                // but cloning the exact tag keeps CI green when GitHub omits or rate-limits assets.
                await cloneTaggedPlugin(source, dest, pluginId);
            }

            await writeFile(metadataPath, `${JSON.stringify(source, null, 4)}\n`, "utf8");
        }

        // Run build steps if package.json is present
        if (await fileExists(pkgPath)) {
            console.log(`[global-setup] installing/building plugin: ${pluginId}`);
            await runCommand("pnpm", ["install", "--silent"], dest, `pnpm install (${pluginId})`);
            await runCommand("pnpm", ["run", "build", "--silent"], dest, `pnpm build (${pluginId})`);
        }

        validatePreparedPlugin(pluginId, dest);
    } catch (err) {
        throw new Error(`[global-setup] Error processing ${pluginId} (${source.repo}): ${err?.message || err}`);
    }
}

/**
 * Main global setup function for Playwright/E2E testing.
 */
export default async function globalSetup() {
    // 1. Ensure the main project is built
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!(await fileExists(mainJsPath))) {
        console.log("[global-setup] main.js missing, running build:nocheck");
        await runCommand("pnpm", ["run", "build:nocheck", "--silent"], repoRoot, "main build");
    }

    if (!(await fileExists(mainJsPath))) {
        throw new Error(`[global-setup] ${mainJsPath} not found after build`);
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

    const failures = [];

    // Fail before launching Obsidian when fixture preparation is incomplete;
    // otherwise every spec degrades into misleading "plugin path not found" noise.
    // 3. Process each plugin sequentially to avoid I/O race conditions
    for (const [pluginId, source] of Object.entries(repoMap)) {
        try {
            await setupExternalPlugin(pluginId, source, repoRoot);
        } catch (err) {
            failures.push(`- ${pluginId}: ${err?.message || err}`);
        }
    }

    if (failures.length > 0) {
        throw new Error(`[global-setup] Failed to prepare external plugins:\n${failures.join("\n")}`);
    }
}
