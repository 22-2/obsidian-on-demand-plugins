import path from "node:path";
import { pathToFileURL } from "node:url";
import { convert } from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";
import libCoverage from "istanbul-lib-coverage";

export async function createE2ECoverageMap(bundle, entries, bundlePath) {
    const root = path.dirname(bundlePath);
    const bundleUrl = pathToFileURL(bundlePath).href;
    const mapMatch = bundle.match(/^\/\/# sourceMappingURL=data:application\/json;base64,(.+)$/m);
    if (!mapMatch) throw new Error("Coverage build is missing its inline source map.");
    const sourceMap = JSON.parse(Buffer.from(mapMatch[1], "base64").toString("utf8"));
    sourceMap.sources = sourceMap.sources.map((source) => path.resolve(root, source));
    // Obsidian removes sourceMappingURL before wrapping and evaluating main.js.
    const code = bundle.slice(0, mapMatch.index);
    const coverageMap = libCoverage.createCoverageMap({});
    const remap = async (functions, wrapperLength = 0) =>
        convert({
            code,
            // The converter tracks visited AST nodes; each conversion needs a fresh tree.
            ast: await parseAstAsync(code),
            sourceMap,
            wrapperLength,
            coverage: { url: bundleUrl, functions },
        });

    // Include bundled source files even when no test executes their code.
    coverageMap.merge(await remap([]));
    for (const entry of entries) {
        // Obsidian wraps main.js in a Function constructor. Detect its actual
        // wrapper offset instead of assuming a fixed prefix.
        const offset = entry.source?.indexOf(code) ?? -1;
        if (offset < 0) throw new Error(`Coverage source does not match main.js: ${entry.url}`);
        coverageMap.merge(await remap(entry.functions, offset));
    }
    coverageMap.filter((filename) => {
        const relative = path.relative(root, filename).replaceAll("\\", "/");
        return relative.startsWith("src/") && !relative.endsWith(".test.ts") && !relative.endsWith(".d.ts") && !relative.includes("/__mocks__/");
    });
    return coverageMap;
}
