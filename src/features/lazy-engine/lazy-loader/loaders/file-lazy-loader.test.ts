import { TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";
import { isPluginLoaded, rebuildLeafView } from "src/core/utils";
import { resolvePluginForFile } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import type { LockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";
import { FileLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/file-lazy-loader";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/utils", () => ({
    isPluginLoaded: vi.fn(),
    rebuildLeafView: vi.fn(),
}));
vi.mock("src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules", () => ({
    resolvePluginForFile: vi.fn(),
}));

type TestFile = TFile;
type TestLeaf = WorkspaceLeaf & {
    view: WorkspaceLeaf["view"] & { file?: TestFile; getState: () => { file?: string } };
    getViewState: () => unknown;
    setViewState: (state: unknown) => Promise<void>;
};

function createFile(path: string): TestFile {
    const name = path.split("/").at(-1) ?? path;
    const basename = name.replace(/\.[^.]+$/, "");
    return Object.assign(new TFile(), { path, name, basename });
}

function createLeaf(id: string, file?: TestFile, initialViewType = "markdown") {
    let viewType = initialViewType;
    const view = {
        file,
        getState: vi.fn(() => ({ file: file?.path })),
        getViewType: vi.fn(() => viewType),
        setViewType: (next: string): void => {
            viewType = next;
        },
    };
    const leaf = {
        id,
        view,
        getViewState: vi.fn(() => ({ state: "current" })),
        setViewState: vi.fn().mockResolvedValue(undefined),
    } as unknown as TestLeaf;
    return { leaf, view };
}

function createHarness(leaves: TestLeaf[] = []) {
    const handlers = new Map<string, (file: TestFile | null) => void>();
    const layoutReadyCallbacks: Array<() => void> = [];
    const workspace = {
        on: vi.fn((event: string, handler: (file: TestFile | null) => void) => {
            handlers.set(event, handler);
            return { event };
        }),
        onLayoutReady: vi.fn((callback: () => void) => layoutReadyCallbacks.push(callback)),
        iterateAllLeaves: vi.fn((callback: (leaf: TestLeaf) => void) => leaves.forEach(callback)),
    };
    const vault = { getAbstractFileByPath: vi.fn() };
    const ctx = {
        app: { workspace, vault },
        registerEvent: vi.fn(),
    } as unknown as PluginContext;
    const pluginLoader = { ensurePluginLoaded: vi.fn().mockResolvedValue(true) };
    const unlock = vi.fn();
    const lockStrategy = { lock: vi.fn().mockResolvedValue({ unlock }) } as unknown as LockStrategy<WorkspaceLeaf>;
    const loader = new FileLazyLoader(ctx, pluginLoader as unknown as ConstructorParameters<typeof FileLazyLoader>[1], lockStrategy);

    return { ctx, handlers, layoutReadyCallbacks, loader, lockStrategy, pluginLoader, unlock, vault, workspace };
}

describe("FileLazyLoader", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(isPluginLoaded).mockReturnValue(false);
        vi.mocked(resolvePluginForFile).mockResolvedValue("file-plugin");
        vi.mocked(rebuildLeafView).mockResolvedValue(undefined);
    });

    it("checks only leaves showing the opened file and rebuilds after loading its plugin", async () => {
        const file = createFile("folder/target.canvas.md");
        const matching = createLeaf("leaf-1", file);
        const other = createLeaf("leaf-2", createFile("folder/other.md"));
        const harness = createHarness([matching.leaf, other.leaf]);
        matching.view.setViewType = (next) => {
            matching.view.getViewType.mockReturnValue(next);
        };
        vi.mocked(rebuildLeafView).mockImplementation(async () => {
            matching.view.setViewType("canvas");
        });
        harness.loader.register();

        harness.handlers.get("file-open")?.(null);
        expect(harness.workspace.iterateAllLeaves).not.toHaveBeenCalled();

        harness.handlers.get("file-open")?.(file);
        await vi.waitFor(() => expect(rebuildLeafView).toHaveBeenCalledWith(matching.leaf));

        expect(resolvePluginForFile).toHaveBeenCalledWith(harness.ctx, file);
        expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledWith("file-plugin");
        expect(resolvePluginForFile).toHaveBeenCalledTimes(1);
        expect(harness.unlock).toHaveBeenCalledOnce();
    });

    it("does not load or rebuild when no plugin matches the file", async () => {
        const file = createFile("folder/note.md");
        const { leaf } = createLeaf("leaf-1", file);
        const harness = createHarness([leaf]);
        vi.mocked(resolvePluginForFile).mockResolvedValue(null);
        harness.loader.register();

        harness.handlers.get("file-open")?.(file);
        await vi.waitFor(() => expect(harness.unlock).toHaveBeenCalledOnce());

        expect(harness.pluginLoader.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(rebuildLeafView).not.toHaveBeenCalled();
    });

    it("skips rebuilding when the plugin is already loaded or fails to load", async () => {
        const file = createFile("folder/note.md");
        const { leaf } = createLeaf("leaf-1", file);
        const harness = createHarness([leaf]);
        harness.loader.register();
        vi.mocked(isPluginLoaded).mockReturnValue(true);
        harness.handlers.get("file-open")?.(file);
        await vi.waitFor(() => expect(harness.unlock).toHaveBeenCalledOnce());

        expect(harness.pluginLoader.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(rebuildLeafView).not.toHaveBeenCalled();

        vi.mocked(isPluginLoaded).mockReturnValue(false);
        harness.pluginLoader.ensurePluginLoaded.mockResolvedValue(false);
        harness.handlers.get("file-open")?.(file);
        await vi.waitFor(() => expect(harness.unlock).toHaveBeenCalledTimes(2));
        expect(rebuildLeafView).not.toHaveBeenCalled();
    });

    it("does not rebuild a view that the plugin already transformed", async () => {
        const file = createFile("folder/note.canvas.md");
        const { leaf } = createLeaf("leaf-1", file, "canvas");
        const harness = createHarness([leaf]);
        harness.loader.register();

        harness.handlers.get("file-open")?.(file);
        await vi.waitFor(() => expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledOnce());

        expect(rebuildLeafView).not.toHaveBeenCalled();
        expect(harness.unlock).toHaveBeenCalledOnce();
    });

    it("scans file-backed leaves after layout is ready", async () => {
        const file = createFile("folder/initial.canvas.md");
        const { leaf } = createLeaf("leaf-1", undefined);
        vi.spyOn(leaf.view, "getState").mockReturnValue({ file: file.path });
        const harness = createHarness([leaf]);
        harness.vault.getAbstractFileByPath.mockReturnValue(file);
        harness.loader.register();

        harness.layoutReadyCallbacks[0]?.();
        await vi.waitFor(() => expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledWith("file-plugin"));

        expect(resolvePluginForFile).toHaveBeenCalledWith(harness.ctx, file);
        expect(rebuildLeafView).toHaveBeenCalledWith(leaf);
    });

    it("ignores leaves without a file path or a TFile, and catches state lookup errors", () => {
        const emptyLeaf = createLeaf("empty").leaf;
        const noStateLeaf = createLeaf("no-state").leaf;
        const nonFileLeaf = createLeaf("non-file").leaf;
        const throwingLeaf = createLeaf("throwing").leaf;
        (noStateLeaf.view as unknown as { getState?: () => { file?: string } }).getState = undefined;
        vi.spyOn(emptyLeaf.view, "getState").mockReturnValue({});
        vi.spyOn(nonFileLeaf.view, "getState").mockReturnValue({ file: "folder/not-a-file" });
        vi.spyOn(throwingLeaf.view, "getState").mockImplementation(() => {
            throw new Error("state unavailable");
        });
        const harness = createHarness([emptyLeaf, noStateLeaf, nonFileLeaf, throwingLeaf]);
        harness.vault.getAbstractFileByPath.mockReturnValue({ path: "folder/not-a-file" });
        harness.loader.register();

        harness.layoutReadyCallbacks[0]?.();

        expect(resolvePluginForFile).not.toHaveBeenCalled();
        expect(harness.vault.getAbstractFileByPath).toHaveBeenCalledTimes(1);
    });
});
