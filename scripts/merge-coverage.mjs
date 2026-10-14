import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCoverageReports } from "obsidian-e2e-toolkit/coverage";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Each E2E shard writes its coverage under coverage/e2e-shards/<artifact name>/ after download.
const shardRoot = path.join(root, "coverage/e2e-shards");
const shardDirs = (await readdir(shardRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
await mergeCoverageReports({
    inputFiles: [
        path.join(root, "coverage/unit/coverage-final.json"),
        ...shardDirs.map((entry) => path.join(shardRoot, entry.name, "coverage-final.json")),
    ],
    outputDir: path.join(root, "coverage/combined"),
});
