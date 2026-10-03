import { readFileSync, writeFileSync } from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("A release version is required (e.g. 3.6.2).");
}
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion) {
    throw new Error("manifest.minAppVersion is required.");
}
const source = readFileSync("versions.json", "utf8");
const errors = [];
const versions = parse(source, errors);
if (errors.length || !versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new Error("versions.json must contain a version map.");
}
// Update the compatibility map only when explicitly requested, preserving existing entries and formatting.
const indentation = source.match(/\n([ \t]+)"/)?.[1] ?? "    ";
const edits = modify(source, [version], manifest.minAppVersion, {
    formattingOptions: {
        insertSpaces: !indentation.includes("\t"),
        tabSize: indentation.length,
        eol: source.includes("\r\n") ? "\r\n" : "\n",
    },
});
if (process.argv.includes("--dry-run")) {
    console.log(`Would map ${version} to Obsidian ${manifest.minAppVersion}.`);
} else {
    writeFileSync("versions.json", applyEdits(source, edits));
}
