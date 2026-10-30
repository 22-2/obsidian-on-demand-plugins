import type { DataAdapter } from "obsidian";

/**
 * Replaces a file through `adapter.process`, so the read and the write run in one
 * adapter queue slot: no other adapter write can land between them, and unchanged
 * content is not rewritten. `next` may throw to abort before anything is written.
 * `process` cannot create files, so a missing file (`current === null`) is written with `adapter.write`.
 */
export async function replaceFileContent(adapter: DataAdapter, path: string, next: (current: string | null) => string): Promise<string> {
    if (await adapter.exists(path)) return adapter.process(path, next);
    const content = next(null);
    await adapter.write(path, content);
    return content;
}
