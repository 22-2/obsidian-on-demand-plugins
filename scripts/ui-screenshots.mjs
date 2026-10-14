import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const device = process.argv[2];
if (device !== "pc" && device !== "mobile") {
    throw new Error("Usage: node scripts/ui-screenshots.mjs <pc|mobile>");
}

const cli = path.join(root, "node_modules/@playwright/test/cli.js");
const child = spawn(process.execPath, [cli, "test", "--config", "playwright.screenshots.config.ts"], {
    cwd: root,
    env: { ...process.env, UI_SCREENSHOT_DEVICE: device },
    stdio: "inherit",
});
child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
});
child.once("exit", (code, signal) => {
    if (signal) console.error(`Screenshot run terminated by ${signal}`);
    process.exitCode = code ?? 1;
});
