// @vitest-environment happy-dom
import type { App, WorkspaceLeaf } from "obsidian";
import { installObsidianDom } from "src/__mocks__/obsidian-dom";
import { PLUGIN_LOAD_STATE_CHANGED_EVENT } from "src/core/constants";
import { PLUGIN_MODE } from "src/core/types";
import type { PluginTableHost } from "src/features/plugin-table/plugin-table-host";
import { PluginTableView, VIEW_TYPE_PLUGIN_TABLE } from "src/features/plugin-table/plugin-table-view";
import type { DraftListener, DraftSession } from "src/ui/drafts/draft-session";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => ({ ...(await import("src/__mocks__/obsidian")), ...(await import("src/__mocks__/obsidian-ui")), setTooltip: () => {} }));

function setup(stored?: unknown) {
    const handlers = new Map<string, () => void>();
    const on = (name: string, handler: () => void) => {
        handlers.set(name, handler);
        return { off: () => handlers.delete(name) };
    };
    const storage = new Map<string, unknown>(stored === undefined ? [] : [["on-demand:plugin-table-state", stored]]);
    const app = {
        workspace: { on },
        plugins: { on, loadManifests: vi.fn(async () => undefined), updates: {}, plugins: {}, enabledPlugins: new Set<string>() },
        vault: { adapter: {}, readConfigJson: vi.fn(async () => []) },
        loadLocalStorage: (key: string) => storage.get(key) ?? null,
        saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
    };
    let listener: DraftListener | undefined;
    const unsubscribe = vi.fn();
    const drafts = {
        pendingPluginIds: new Set<string>(),
        hasPendingChanges: false,
        describeChanges: () => [],
        openSurface: vi.fn(),
        closeSurface: vi.fn(),
        requestRestoreOnPageClose: vi.fn(),
        offerRestoreOnPageOpen: vi.fn(),
        onChange: (next: DraftListener) => {
            listener = next;
            return unsubscribe;
        },
    };
    const getManifests = vi.fn(() => [{ id: "alpha", name: "Alpha", version: "1.0.0", author: "Ann", description: "" }]);
    const host = {
        app: app as unknown as App,
        drafts: drafts as unknown as DraftSession,
        selfId: "on-demand-plugins",
        getManifests,
        getMode: () => PLUGIN_MODE.LAZY,
        stageMode: () => false,
        openLazyOptions: vi.fn(),
    } as unknown as PluginTableHost;
    const view = new PluginTableView({ app } as unknown as WorkspaceLeaf, host);
    document.body.appendChild((view as unknown as { containerEl: HTMLElement }).containerEl);
    return { app, view, drafts, handlers, storage, getManifests, unsubscribe, emit: (...args: Parameters<DraftListener>) => listener?.(...args) };
}

beforeAll(() => installObsidianDom());

afterEach(() => {
    document.body.empty();
    document.body.className = "";
});

describe("plugin table view", () => {
    it("names itself for the workspace", () => {
        const { view } = setup();
        expect(view.getViewType()).toBe(VIEW_TYPE_PLUGIN_TABLE);
        expect(view.getDisplayText()).toBe("Plugin table");
        expect(view.getIcon()).toBe("table");
    });

    it("joins the shared draft while open and offers a set-aside draft on open", async () => {
        const { view, drafts, unsubscribe } = setup();
        await view.onOpen();
        expect(drafts.openSurface).toHaveBeenCalledWith("plugin-table");
        expect(drafts.offerRestoreOnPageOpen).toHaveBeenCalledWith("plugin-table");
        expect(view.contentEl.querySelector(".lazy-plugin-table")).not.toBeNull();

        await view.onClose();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(drafts.requestRestoreOnPageClose).toHaveBeenCalledWith("plugin-table");
        expect(drafts.closeSurface).toHaveBeenCalledWith("plugin-table");
        expect(view.contentEl.querySelector(".lazy-plugin-table")).toBeNull();
    });

    it("re-reads the rows for draft changes from other surfaces and for plugin events", async () => {
        const { app, view, emit, handlers, getManifests } = setup();
        await view.onOpen();
        const reads = () => getManifests.mock.calls.length;
        const before = reads();

        emit("edit", {});
        emit("refresh", undefined);
        handlers.get("changed")!();
        expect(reads()).toBe(before + 3);

        // The refresh action rescans the plugins folder first, so the copied-in plugins show up.
        (view as unknown as { actions: { callback: () => void }[] }).actions[0].callback();
        await vi.waitFor(() => expect(reads()).toBe(before + 4));
        expect(app.plugins.loadManifests).toHaveBeenCalledOnce();

        handlers.get(PLUGIN_LOAD_STATE_CHANGED_EVENT)!();
        expect(reads()).toBe(before + 4);
    });

    it("ignores the echo of the table's own edits", async () => {
        const { view, emit, getManifests } = setup();
        await view.onOpen();
        const table = (view as unknown as { table: unknown }).table;
        const before = getManifests.mock.calls.length;
        emit("edit", table);
        expect(getManifests.mock.calls.length).toBe(before);
    });

    it("keeps the table state in local storage, with phone defaults when nothing is stored", async () => {
        document.body.className = "is-phone";
        const phone = setup();
        await phone.view.onOpen();
        expect(phone.view.contentEl.querySelector("thead .lazy-plugin-table-col-description")).toBeNull();
        document.body.empty();
        document.body.className = "";

        const stored = setup({ sorting: [], columnVisibility: { id: true }, columnWidths: {} });
        await stored.view.onOpen();
        expect(stored.view.contentEl.querySelector("thead .lazy-plugin-table-col-id")).not.toBeNull();
        stored.view.contentEl.querySelector<HTMLElement>("thead .lazy-plugin-table-col-name")!.click();
        expect(stored.storage.get("on-demand:plugin-table-state")).toEqual(expect.objectContaining({ sorting: [{ id: "name", desc: false }] }));
    });
});
