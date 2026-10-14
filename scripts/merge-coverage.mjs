import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCoverageReports } from "obsidian-e2e-toolkit/coverage";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mergeCoverageReports({
    inputFiles: ["unit", "e2e"].map((kind) => path.join(root, "coverage", kind, "coverage-final.json")),
    outputDir: path.join(root, "coverage/combined"),
});
