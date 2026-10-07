import { readFileSync, statSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const expectedVersion = process.argv[2] ?? pkg.version;
// Stop before publishing if the selected tag and release assets have different versions.
if (manifest.id !== "on-demand-plugins" || manifest.version !== expectedVersion || pkg.version !== expectedVersion) {
    throw new Error("Release tag, package version and plugin manifest must match.");
}
for (const file of ["main.js", "styles.css", "manifest.json"]) {
    const stat = statSync(file);
    if (!stat.isFile() || !stat.size) throw new Error(`Missing release asset: ${file}`);
}
console.log(`Verified release assets for ${expectedVersion}.`);
