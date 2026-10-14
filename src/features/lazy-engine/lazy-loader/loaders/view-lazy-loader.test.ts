import type { WorkspaceLeaf } from "obsidian";
import type { CommandRegistry } from "src/core/interfaces";
import type { PluginContext } from "src/core/plugin-context";
import { isLeafVisible, isPluginLoaded } from "src/core/utils";
import { resolvePluginForViewType } from "src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules";
import { ViewLazyLoader } from "src/features/lazy-engine/lazy-loader/loaders/view-lazy-loader";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/utils", () => ({
    isLeafVisible: vi.fn(),
    isPluginLoaded: vi.fn(),
}));
vi.mock("src/features/lazy-engine/lazy-loader/loaders/internal/activation-rules", () => ({
    resolvePluginForViewType: vi.fn(),
}));

function createLeaf(id: string, viewType: string): WorkspaceLeaf {
    return {
        id,
        view: { getViewType: vi.fn(() => viewType) },
    } as unknown as WorkspaceLeaf;
}

function createHarness(layoutReady = true, leaves: WorkspaceLeaf[] = []) {
    const eventHandlers = new Map<string, (leaf: WorkspaceLeaf | null) => void>();
    const layoutReadyCallbacks: Array<() => void> = [];
    const workspace = {
        layoutReady,
        on: vi.fn((event: string, handler: (leaf: WorkspaceLeaf | null) => void) => {
            eventHandlers.set(event, handler);
            return { event };
        }),
        onLayoutReady: vi.fn((callback: () => void) => layoutReadyCallbacks.push(callback)),
        iterateAllLeaves: vi.fn((callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback)),
    };
    const ctx = { app: { workspace }, registerEvent: vi.fn() } as unknown as PluginContext;
    const pluginLoader = { ensurePluginLoaded: vi.fn().mockResolvedValue(true) };
    const commandRegistry = { syncCommandWrappersForPlugin: vi.fn() };
    const unlock = vi.fn();
    const lockStrategy = { lock: vi.fn().mockResolvedValue({ unlock }) };
    const loader = new ViewLazyLoader(ctx, pluginLoader as unknown as ConstructorParameters<typeof ViewLazyLoader>[1], commandRegistry as unknown as CommandRegistry, lockStrategy);

    return { commandRegistry, ctx, eventHandlers, layoutReadyCallbacks, loader, lockStrategy, pluginLoader, unlock, workspace };
}

describe("ViewLazyLoader", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(isLeafVisible).mockReturnValue(true);
        vi.mocked(isPluginLoaded).mockReturnValue(false);
        vi.mocked(resolvePluginForViewType).mockReturnValue("view-plugin");
    });

    it("waits for layout readiness and visibility before acquiring a lock", async () => {
        const hiddenLeaf = createLeaf("leaf-hidden", "canvas");
        const harness = createHarness(false);
        await harness.loader.initializeLazyViewForLeaf(hiddenLeaf);
        expect(harness.lockStrategy.lock.mock.calls).toHaveLength(0);

        harness.workspace.layoutReady = true;
        vi.mocked(isLeafVisible).mockReturnValue(false);
        await harness.loader.initializeLazyViewForLeaf(hiddenLeaf);

        expect(harness.lockStrategy.lock.mock.calls).toHaveLength(0);
        expect(harness.commandRegistry.syncCommandWrappersForPlugin).not.toHaveBeenCalled();
    });

    it("ignores a missing leaf", async () => {
        const harness = createHarness();

        await harness.loader.initializeLazyViewForLeaf(null as unknown as WorkspaceLeaf);

        expect(harness.lockStrategy.lock.mock.calls).toHaveLength(0);
        expect(resolvePluginForViewType).not.toHaveBeenCalled();
    });

    it("loads a matching plugin under the leaf lock and synchronizes its commands", async () => {
        const leaf = createLeaf("leaf-1", "canvas");
        const harness = createHarness();

        await harness.loader.initializeLazyViewForLeaf(leaf);

        expect(harness.lockStrategy.lock.mock.calls).toContainEqual([{ leaf, viewType: "canvas" }]);
        expect(resolvePluginForViewType).toHaveBeenCalledWith(harness.ctx, "canvas");
        expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledWith("view-plugin");
        expect(harness.commandRegistry.syncCommandWrappersForPlugin).toHaveBeenCalledWith("view-plugin");
        expect(harness.unlock).toHaveBeenCalledOnce();
    });

    it("does not ensure an already loaded plugin but still synchronizes its commands", async () => {
        const leaf = createLeaf("leaf-1", "canvas");
        const harness = createHarness();
        vi.mocked(isPluginLoaded).mockReturnValue(true);

        await harness.loader.initializeLazyViewForLeaf(leaf);

        expect(harness.pluginLoader.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(harness.commandRegistry.syncCommandWrappersForPlugin).toHaveBeenCalledWith("view-plugin");
    });

    it("does not synchronize commands when no plugin matches the view type", async () => {
        const leaf = createLeaf("leaf-1", "markdown");
        const harness = createHarness();
        vi.mocked(resolvePluginForViewType).mockReturnValue(null);

        await harness.loader.initializeLazyViewForLeaf(leaf);

        expect(harness.pluginLoader.ensurePluginLoaded).not.toHaveBeenCalled();
        expect(harness.commandRegistry.syncCommandWrappersForPlugin).not.toHaveBeenCalled();
        expect(harness.unlock).toHaveBeenCalledOnce();
    });

    it("ensures a plugin for an explicit view type only when the layout is ready", async () => {
        const harness = createHarness(false);
        await harness.loader.checkViewTypeForLazyLoading("canvas");
        expect(resolvePluginForViewType).not.toHaveBeenCalled();

        harness.workspace.layoutReady = true;
        await harness.loader.checkViewTypeForLazyLoading("");
        expect(resolvePluginForViewType).not.toHaveBeenCalled();

        await harness.loader.checkViewTypeForLazyLoading("canvas");
        expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledWith("view-plugin");
    });

    it("does not ensure a plugin when an explicit view type has no matching rule", async () => {
        const harness = createHarness();
        vi.mocked(resolvePluginForViewType).mockReturnValue(null);

        await harness.loader.checkViewTypeForLazyLoading("canvas");

        expect(resolvePluginForViewType).toHaveBeenCalledWith(harness.ctx, "canvas");
        expect(harness.pluginLoader.ensurePluginLoaded).not.toHaveBeenCalled();
    });

    it("registers active-leaf and initial-layout scans", async () => {
        const leaf = createLeaf("leaf-1", "canvas");
        const harness = createHarness(true, [leaf]);
        harness.loader.registerActiveLeafReload();
        harness.eventHandlers.get("active-leaf-change")?.(null);
        expect(harness.lockStrategy.lock.mock.calls).toHaveLength(0);
        harness.eventHandlers.get("active-leaf-change")?.(leaf);
        harness.layoutReadyCallbacks[0]?.();

        await vi.waitFor(() => expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalled());

        expect(harness.workspace.on).toHaveBeenCalledWith("active-leaf-change", expect.any(Function));
        expect(harness.workspace.iterateAllLeaves).toHaveBeenCalledOnce();
    });

    it("loads visible lazy leaves on a workspace resize, such as a sidebar expanding", async () => {
        const leaf = createLeaf("leaf-1", "nav-view");
        const harness = createHarness(true, [leaf]);
        harness.loader.registerActiveLeafReload();

        harness.eventHandlers.get("resize")?.(null);

        await vi.waitFor(() => expect(harness.pluginLoader.ensurePluginLoaded).toHaveBeenCalledWith("view-plugin"));
        expect(harness.lockStrategy.lock.mock.calls).toContainEqual([{ leaf, viewType: "nav-view" }]);
    });

    it("skips hidden, unmatched and already loaded leaves when scanning visible leaves", () => {
        const hidden = createLeaf("hidden", "nav-view");
        const unmatched = createLeaf("unmatched", "markdown");
        const loaded = createLeaf("loaded", "loaded-view");
        const harness = createHarness(true, [hidden, unmatched, loaded]);
        vi.mocked(isLeafVisible).mockImplementation((leaf) => leaf !== hidden);
        vi.mocked(resolvePluginForViewType).mockImplementation((_ctx, viewType) => (viewType === "markdown" ? null : "view-plugin"));
        vi.mocked(isPluginLoaded).mockReturnValue(true);

        harness.loader.initializeVisibleLazyLeaves();

        expect(harness.lockStrategy.lock).not.toHaveBeenCalled();
        expect(resolvePluginForViewType).not.toHaveBeenCalledWith(harness.ctx, "nav-view");
    });

    it("does not scan visible leaves before the layout is ready", () => {
        const harness = createHarness(false, [createLeaf("leaf-1", "nav-view")]);

        harness.loader.initializeVisibleLazyLeaves();

        expect(harness.workspace.iterateAllLeaves).not.toHaveBeenCalled();
    });
});
