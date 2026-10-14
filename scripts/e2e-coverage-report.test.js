import { describe, expect, test } from "vitest";
import { transform } from "esbuild";
import path from "node:path";
import { createE2ECoverageMap } from "./e2e-coverage-report.mjs";

const bundlePath = path.resolve("main.js");
const sourcePath = path.resolve("src/coverage-fixture.ts");

async function fixture() {
    const { code: bundle } = await transform("function answer(): number { return 42; } answer();", {
        loader: "ts",
        sourcefile: sourcePath,
        sourcemap: "inline",
        format: "cjs",
    });
    const code = bundle.slice(0, bundle.indexOf("//# sourceMappingURL="));
    const prefix = "(function anonymous(require,module,exports){";
    return {
        bundle,
        entry: {
            url: "plugin:on-demand-plugins",
            source: `${prefix}${code}\n})\n//# sourceURL=plugin:on-demand-plugins\n`,
            functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: prefix.length, endOffset: prefix.length + code.length, count: 1 }] }],
        },
    };
}

describe("E2E coverage source mapping", () => {
    test("maps stripped source maps and runtime wrappers back to TypeScript", async () => {
        const { bundle, entry } = await fixture();
        const coverage = await createE2ECoverageMap(bundle, [entry, entry], bundlePath);
        expect(coverage.files()).toEqual([sourcePath]);
        const file = coverage.fileCoverageFor(sourcePath);
        expect(file.toSummary().lines.pct).toBe(100);
        expect(Object.values(file.f)).toEqual([2]);
    });

    test("reports unexecuted bundled code as uncovered", async () => {
        const { bundle } = await fixture();
        const coverage = await createE2ECoverageMap(bundle, [], bundlePath);
        const summary = coverage.getCoverageSummary();
        expect(summary.lines.total).toBeGreaterThan(0);
        expect(summary.lines.pct).toBe(0);
        expect(summary.functions.pct).toBe(0);
    });

    test("rejects stale bundles and missing source maps", async () => {
        const { bundle, entry } = await fixture();
        await expect(createE2ECoverageMap(bundle, [{ ...entry, source: "stale" }], bundlePath)).rejects.toThrow("Coverage source does not match main.js");
        await expect(createE2ECoverageMap("no source map", [], bundlePath)).rejects.toThrow("missing its inline source map");
    });
});
