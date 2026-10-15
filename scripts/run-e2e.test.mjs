import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runE2EPhases } from "./run-e2e.mjs";

test("a failed parallel test and a passed serial test retain both reports and attachments", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "on-demand-e2e-runner-"));
    t.after(async () => {
        assert.equal(path.dirname(root), os.tmpdir());
        await rm(root, { recursive: true, force: true });
    });
    const playwright = pathToFileURL(createRequire(import.meta.url).resolve("@playwright/test")).href;
    await mkdir(path.join(root, "specs"));
    const config = path.join(root, "playwright.config.mjs");
    const evidence = path.join(root, "failure-evidence.txt");
    await writeFile(evidence, "failure evidence");
    await writeFile(config, `export default { testDir: "./specs", workers: 1, retries: 0 };`);
    await writeFile(path.join(root, "specs", "report.spec.mjs"), `
        import playwright from ${JSON.stringify(playwright)};
        const { test, expect } = playwright;
        test("parallel failure", async ({}, info) => {
            await info.attach("parallel-proof", { path: ${JSON.stringify(evidence)}, contentType: "text/plain" });
            expect(1).toBe(2);
        });
        test("serial success", { tag: "@serial" }, async ({}, info) => {
            await info.attach("serial-proof", { body: Buffer.from("serial evidence"), contentType: "text/plain" });
        });
    `);

    const exitCode = await runE2EPhases(["--", "--config", config], {}, root);

    assert.equal(exitCode, 1);
    assert.equal(existsSync(path.join(root, "playwright-report", "index.html")), true);
    const report = JSON.parse(await readFile(path.join(root, "playwright-report", "results.json"), "utf8"));
    assert.equal(report.stats.expected, 1);
    assert.equal(report.stats.unexpected, 1);
    const specs = report.suites.flatMap((suite) => suite.specs);
    assert.deepEqual(specs.map((spec) => spec.title).sort(), ["parallel failure", "serial success"]);
    const attachments = specs.flatMap((spec) => spec.tests.flatMap((entry) => entry.results.flatMap((result) => result.attachments)));
    const proofs = attachments.filter((entry) => entry.name.endsWith("-proof"));
    assert.deepEqual(proofs.map((entry) => entry.name).sort(), ["parallel-proof", "serial-proof"]);
    for (const attachment of proofs) {
        const content = attachment.path
            ? await readFile(attachment.path, "utf8")
            : Buffer.from(attachment.body, "base64").toString("utf8");
        assert.equal(content, attachment.name === "parallel-proof" ? "failure evidence" : "serial evidence");
    }
});
