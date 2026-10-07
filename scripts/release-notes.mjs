import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable release version is required.");
const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const heading = new RegExp(`^#{2,3} \\[?${version.replaceAll(".", "\\.")}\\]?(?:\\s|\\(|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start < 0) throw new Error(`No changelog entry for ${version}.`);
const next = lines.findIndex((line, index) => index > start && /^#{2,3} \[?\d+\.\d+\.\d+/.test(line));
// Use the locally generated Conventional Commits notes for the GitHub Release.
console.log(
    lines
        .slice(start, next < 0 ? undefined : next)
        .join("\n")
        .trim(),
);
