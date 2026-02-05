import path from "node:path";
import fs from "node:fs";
import { fetchPlugin } from "obsidian-e2e-toolkit";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(exec);

export default async function globalSetup() {
    const repoRoot = process.cwd();
    const mainJsPath = path.resolve(repoRoot, "main.js");
    if (!fs.existsSync(mainJsPath)) {
        try {
            console.log("[global-setup] main.js missing, running build:nocheck");
            await execP("pnpm run build:nocheck --silent", { cwd: repoRoot });
        } catch (e) {
            console.warn(
                "[global-setup] build:nocheck failed (ignored):",
                e?.message || e,
            );
        }
    }

    const repoMapPath = path.resolve(
        process.cwd(),
        "tests",
        "plugin-sources.json",
    );
    if (!fs.existsSync(repoMapPath)) {
        console.warn(
            "No plugin-sources.json found; skipping plugin fetch in global setup",
        );
        return;
    }

    const repoMap = JSON.parse(fs.readFileSync(repoMapPath, "utf8"));
    for (const [pluginId, ownerRepo] of Object.entries(repoMap)) {
        try {
            const dest = path.resolve(process.cwd(), "myfiles", pluginId);

            // Check if plugin already cached locally (manifest.json = downloaded)
            const hasManifest = fs.existsSync(path.join(dest, "manifest.json"));
            if (hasManifest) {
                console.log(`[global-setup] ${pluginId} already cached, skipping fetch`);
            } else {
                console.log(`[global-setup] fetching ${ownerRepo} -> ${dest}`);
                await fetchPlugin(`https://github.com/${ownerRepo}.git`, dest);
            }

            // if plugin has package.json, try install & build (best-effort)
            const pkgPath = path.join(dest, "package.json");
            if (fs.existsSync(pkgPath)) {
                console.log(
                    `[global-setup] installing/building plugin ${pluginId}`,
                );
                try {
                    await execP("pnpm install --silent", { cwd: dest });
                } catch (e) {
                    console.warn(
                        `[global-setup] pnpm install failed for ${pluginId} (ignored):`,
                        e?.message || e,
                    );
                }
                try {
                    await execP("pnpm run build --silent", { cwd: dest });
                } catch (e) {
                    console.warn(
                        `[global-setup] pnpm run build failed for ${pluginId} (ignored):`,
                        e?.message || e,
                    );
                }
            }
        } catch (e) {
            console.warn(
                `[global-setup] fetch failed for ${pluginId} (${ownerRepo}) (ignored):`,
                e?.message || e,
            );
        }
    }
}
