// @vitest-environment happy-dom
import type { App, PluginManifest } from "obsidian";
import { installObsidianDom } from "src/__mocks__/obsidian-dom";
import { Menu } from "src/__mocks__/obsidian-ui";
import { FileSystemAdapter, Notice, Platform } from "src/__mocks__/obsidian";
import { PLUGIN_MODE } from "src/core/types";
import type { PLUGIN_MODE as PluginMode } from "src/core/types";
import { PluginTable } from "src/features/plugin-table/plugin-table";
import type { PluginTableHost } from "src/features/plugin-table/plugin-table-host";
import { defaultTableState } from "src/features/plugin-table/table-state";
import type { PluginTableState } from "src/features/plugin-table/table-state";
import type { DraftSession } from "src/ui/drafts/draft-session";
import { openPluginDirectory } from "src/ui/settings/helpers";
import { showInCommunityPlugins } from "src/ui/show-in-community-plugins";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Obsidian's setTooltip also stores the text as the element's aria-label.
vi.mock("obsidian", async () => ({ ...(await import("src/__mocks__/obsidian")), ...(await import("src/__mocks__/obsidian-ui")), setTooltip: (el: HTMLElement, text: string) => el.setAttribute("aria-label", text) }));
vi.mock("src/ui/show-in-community-plugins", () => ({ showInCommunityPlugins: vi.fn() }));
vi.mock("src/ui/settings/helpers", async (importOriginal) => ({ ...(await importOriginal<typeof import("src/ui/settings/helpers")>()), openPluginDirectory: vi.fn() }));

const MANIFESTS = [
    { id: "alpha", name: "Alpha", version: "1.0.0", author: "Ann ", description: "First plugin", dir: "config/plugins/alpha" },
    { id: "beta", name: "Beta", version: "2.0.0", author: "Bob", description: "Second plugin", dir: "config/plugins/beta" },
    { id: "gamma", name: "Gamma", version: "3.0.0", author: "Cy", description: "Third plugin" },
] as PluginManifest[];

function setup(options: { touch?: boolean; state?: PluginTableState; saved?: unknown; extra?: PluginManifest[] } = {}) {
    document.body.className = options.touch ? "is-mobile" : "";
    const modes: Record<string, PluginMode> = { alpha: PLUGIN_MODE.LAZY, beta: PLUGIN_MODE.ALWAYS_ENABLED, gamma: PLUGIN_MODE.ALWAYS_DISABLED, delta: PLUGIN_MODE.LAZY_ON_LAYOUT_READY };
    const loaded = new Set(["beta"]);
    const app = {
        plugins: {
            updates: { alpha: { version: "1.1.0" } } as Record<string, { version: string }>,
            plugins: {} as Record<string, { _loaded: boolean }>,
            enabledPlugins: new Set<string>(),
        },
        vault: { adapter: {} as object, readConfigJson: vi.fn(async () => options.saved ?? ["beta"]) },
        setting: { open: vi.fn(), openTabById: vi.fn() },
    };
    const syncLoaded = () => {
        app.plugins.plugins = Object.fromEntries([...loaded].map((id) => [id, { _loaded: true }]));
    };
    syncLoaded();
    const drafts = {
        pendingPluginIds: new Set<string>(),
        hasPendingChanges: false,
        describeChanges: vi.fn(() => [{ group: "plugins", label: "Alpha", to: "x" }]),
        markDirty: vi.fn(),
        reviewAndSave: vi.fn(async () => {}),
        discardChanges: vi.fn(async () => true),
    };
    const openLazyOptions = vi.fn();
    const host: PluginTableHost = {
        app: app as unknown as App,
        drafts: drafts as unknown as DraftSession,
        getManifests: () => [...MANIFESTS, ...(options.extra ?? [])],
        getMode: (id) => modes[id],
        stageMode: (id, mode) => {
            if (modes[id] === mode) return false;
            modes[id] = mode;
            return true;
        },
        openLazyOptions,
    };
    const onStateChange = vi.fn<(state: PluginTableState) => void>();
    const root = document.body.createDiv();
    const table = new PluginTable(root, host, { initialState: options.state ?? defaultTableState(false), onStateChange });
    const rows = () => [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    const rowOf = (name: string) => rows().find((tr) => tr.querySelector(".lazy-plugin-table-name")?.textContent === name)!;
    const names = () => rows().map((tr) => tr.querySelector(".lazy-plugin-table-name")?.textContent);
    const header = (id: string) => root.querySelector<HTMLElement>(`thead .lazy-plugin-table-th.lazy-plugin-table-col-${id}`)!;
    const summary = (filter: string) => root.querySelector<HTMLButtonElement>(`.lazy-plugin-table-summary-item-${filter}`)!;
    const select = (tr: HTMLElement) => tr.querySelector<HTMLSelectElement>(".lazy-plugin-table-mode-cell select")!;
    const gear = (tr: HTMLElement) => tr.querySelector<HTMLElement>(".lazy-plugin-table-mode-cell .clickable-icon")!;
    const pendingButton = (text: string) => [...root.querySelectorAll<HTMLButtonElement>(".lazy-plugin-table-pending button")].find((button) => button.textContent === text)!;
    return { app, root, table, drafts, modes, loaded, syncLoaded, openLazyOptions, onStateChange, rows, rowOf, names, header, summary, select, gear, pendingButton };
}

function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
    el.value = value;
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input"));
}

function rightClick(el: HTMLElement) {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
    return Menu.last();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => installObsidianDom());

beforeEach(() => {
    Menu.shown = [];
    Notice.clearMessages();
    Platform.isDesktopApp = false;
    vi.mocked(showInCommunityPlugins).mockClear();
    vi.mocked(openPluginDirectory).mockClear();
});

afterEach(() => {
    document.body.empty();
});

describe("plugin table rendering", () => {
    it("lists plugins loaded first, with versions, updates and a lamp for the load state", async () => {
        const { names, rowOf, summary, root } = setup();
        await flush();

        expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
        const alpha = rowOf("Alpha");
        expect(alpha.querySelector(".lazy-plugin-table-version")?.textContent).toBe("1.0.0");
        expect(alpha.querySelector(".lazy-plugin-table-update-icon")).not.toBeNull();
        // The author sits beside the name instead of in a column of its own.
        expect(alpha.querySelector(".lazy-plugin-table-author")?.textContent).toBe("Ann");
        // Only the loaded state has a tooltip, for the in-memory detail its short label leaves out.
        expect(alpha.querySelector(".lazy-plugin-table-col-name")!.hasAttribute("aria-label")).toBe(false);
        expect(alpha.querySelector(".lazy-plugin-table-col-description")!.hasAttribute("aria-label")).toBe(false);
        expect(root.querySelector("thead .lazy-plugin-table-col-author")).toBeNull();
        expect(rowOf("Beta").classList.contains("is-loaded")).toBe(true);
        expect(rowOf("Beta").querySelector(".lazy-plugin-table-lamp.is-loaded")).not.toBeNull();
        expect(summary("enabled").querySelector("strong")?.textContent).toBe("1");
        expect(summary("updates").style.display).toBe("");
        // The ID column is hidden by default.
        expect(root.querySelector("thead .lazy-plugin-table-col-id")).toBeNull();
    });

    it("marks a plugin loaded only in memory once community-plugins.json is read", async () => {
        const { rowOf, loaded, syncLoaded, table } = setup({ saved: [] });
        loaded.add("gamma");
        syncLoaded();
        table.refreshLoadState();
        await flush();

        expect(rowOf("Gamma").querySelector(".lazy-plugin-table-lamp.is-memory-only")).not.toBeNull();
        const cell = rowOf("Gamma").querySelector<HTMLElement>(".lazy-plugin-table-col-loaded")!;
        expect(cell.textContent).toBe("Yes");
        expect(cell.getAttribute("aria-label")).toBe("Loaded (in memory only)");
    });

    it("ignores an unreadable community-plugins.json", async () => {
        const { rowOf, app, table } = setup();
        app.vault.readConfigJson.mockRejectedValueOnce(new Error("missing"));
        table.refresh();
        await flush();

        expect(rowOf("Beta").querySelector(".lazy-plugin-table-col-loaded")?.textContent).toBe("Yes");
        expect(rowOf("Alpha").querySelector(".lazy-plugin-table-col-loaded")?.textContent).toBe("No");
    });

    it("adds a row menu button only on touch layouts", () => {
        const desktop = setup();
        expect(desktop.root.querySelector(".lazy-plugin-table-col-actions")).toBeNull();
        document.body.empty();

        const touch = setup({ touch: true });
        const button = touch.rowOf("Alpha").querySelector<HTMLElement>(".lazy-plugin-table-col-actions .clickable-icon")!;
        button.click();

        expect(Menu.last().find("Lazy settings")).toBeDefined();
        expect(touch.rowOf("Alpha").classList.contains("is-selected")).toBe(true);
    });

    it("removes itself on destroy", () => {
        const { root, table } = setup();
        table.destroy();
        expect(root.querySelector(".lazy-plugin-table-container")).toBeNull();
    });
});

describe("plugin table filters and sorting", () => {
    it("filters by text, load state and mode", () => {
        const { root, names } = setup();
        change(root.querySelector<HTMLInputElement>("input[aria-label='Filter Name']")!, "a");
        expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
        // The name filter also finds a plugin by its author.
        change(root.querySelector<HTMLInputElement>("input[aria-label='Filter Name']")!, "BOB");
        expect(names()).toEqual(["Beta"]);
        change(root.querySelector<HTMLInputElement>("input[aria-label='Filter Name']")!, "");
        change(root.querySelector<HTMLInputElement>("input[aria-label='Filter Description']")!, "second");
        expect(names()).toEqual(["Beta"]);
        change(root.querySelector<HTMLInputElement>("input[aria-label='Filter Description']")!, "");

        change(root.querySelector<HTMLSelectElement>("select[aria-label='Filter Loaded']")!, "false");
        expect(names()).toEqual(["Alpha", "Gamma"]);
        change(root.querySelector<HTMLSelectElement>("select[aria-label='Filter Mode']")!, PLUGIN_MODE.ALWAYS_DISABLED);
        expect(names()).toEqual(["Gamma"]);
        change(root.querySelector<HTMLSelectElement>("select[aria-label='Filter Mode']")!, "");
        expect(names()).toEqual(["Alpha", "Gamma"]);
    });

    it("toggles the summary filters and leaves the updates view once nothing is left to update", () => {
        const { summary, names, table, app } = setup();
        summary("enabled").click();
        expect(names()).toEqual(["Beta"]);
        expect(summary("enabled").getAttribute("aria-pressed")).toBe("true");
        summary("disabled").click();
        expect(names()).toEqual(["Alpha", "Gamma"]);
        summary("disabled").click();
        expect(names()).toHaveLength(3);

        summary("updates").click();
        expect(names()).toEqual(["Alpha"]);
        app.plugins.updates = {};
        table.refresh();
        expect(names()).toHaveLength(3);
        expect(summary("updates").style.display).toBe("none");
    });

    it("sorts by header clicks, with modes in their own order", () => {
        const { header, names, onStateChange } = setup();
        header("mode").click();
        expect(names()).toEqual(["Gamma", "Alpha", "Beta"]);
        expect(header("mode").textContent).toContain("▲");
        header("mode").click();
        expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
        expect(header("mode").textContent).toContain("▼");
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sorting: [{ id: "mode", desc: true }] }));
    });

    it("sorts and hides columns from the header menu", () => {
        const { header, names, root, onStateChange } = setup();
        const menu = rightClick(header("name"));
        menu.find("Sort descending")!.click();
        expect(names()).toEqual(["Gamma", "Beta", "Alpha"]);
        rightClick(header("name")).find("Sort ascending")!.click();
        expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);

        const columns = rightClick(header("description")).find("Columns")!.submenu!;
        expect(columns.items.map((item) => item.title)).toEqual(["ID", "Loaded", "Mode", "Description"]);
        columns.find("Description")!.click();
        expect(root.querySelector("thead .lazy-plugin-table-col-description")).toBeNull();
        expect(onStateChange.mock.lastCall?.[0].columnVisibility.description).toBe(false);
    });

    it("resizes a column by dragging its handle", () => {
        const { header, onStateChange, root } = setup();
        const handle = header("loaded").querySelector<HTMLElement>(".lazy-plugin-table-resizer")!;
        handle.setPointerCapture = () => {};
        handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, pointerId: 1 }));
        handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 10 }));
        handle.dispatchEvent(new PointerEvent("pointerup"));

        // happy-dom has no layout, so the drag starts from a zero width and stops at the minimum.
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ columnWidths: { loaded: 60 } }));
        const loadedCol = root.querySelectorAll("col")[1] as HTMLElement;
        expect(loadedCol.style.width).toBe("60px");
        // The table's minimum width follows, so it still scrolls sideways instead of squeezing a column.
        expect(root.querySelector<HTMLElement>(".lazy-plugin-table")!.style.minWidth).toBe("840px");
    });

    it("restores saved widths and keeps sorting clicks off the resize handle", () => {
        const state = { ...defaultTableState(false), columnWidths: { name: 300, mode: 210 } };
        const { header, root, names } = setup({ state });
        expect((root.querySelector("col") as HTMLElement).style.width).toBe("300px");
        // Name, loaded and mode widths, plus the description's minimum.
        expect(root.querySelector<HTMLElement>(".lazy-plugin-table")!.style.minWidth).toBe("840px");
        header("name").querySelector<HTMLElement>(".lazy-plugin-table-resizer")!.click();
        expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    });
});

describe("plugin table mode editing", () => {
    it("stages a mode from the dropdown and updates the gear in place", () => {
        const { rowOf, select, gear, drafts, names } = setup();
        const alpha = rowOf("Alpha");
        expect(gear(alpha).classList.contains("is-disabled")).toBe(false);

        change(select(alpha), PLUGIN_MODE.ALWAYS_ENABLED);

        expect(drafts.pendingPluginIds.has("alpha")).toBe(true);
        expect(drafts.markDirty).toHaveBeenCalledOnce();
        // Lazy options only apply to Lazy on demand, so the gear hides but keeps its place.
        expect(gear(alpha).classList.contains("is-disabled")).toBe(true);
        // The row stays where it was until the filters or sorting change.
        expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    });

    it("leaves the draft clean when the chosen mode is the current one", () => {
        const { rowOf, select, drafts } = setup();
        change(select(rowOf("Alpha")), PLUGIN_MODE.LAZY);
        expect(drafts.markDirty).not.toHaveBeenCalled();
    });

    it("opens the lazy options from the gear only in Lazy on demand", () => {
        const { rowOf, gear, openLazyOptions, drafts } = setup();
        gear(rowOf("Gamma")).click();
        expect(openLazyOptions).not.toHaveBeenCalled();

        gear(rowOf("Alpha")).click();
        expect(openLazyOptions).toHaveBeenCalledWith("alpha", expect.any(Function));
        const onSave = openLazyOptions.mock.calls[0][1] as () => void;
        onSave();
        expect(drafts.pendingPluginIds.has("alpha")).toBe(true);
        expect(drafts.markDirty).toHaveBeenCalled();
    });

    it("shows the draft bar and hands review and discard to the draft", () => {
        const { root, drafts, table, pendingButton } = setup();
        // Like the settings bar, nothing shows while the draft is clean.
        expect(root.querySelector(".lazy-plugin-table-pending")?.childElementCount).toBe(0);

        drafts.hasPendingChanges = true;
        table.refreshPendingBar();
        expect(root.querySelector(".lazy-plugin-table-pending-text")?.textContent).toContain("1 unsaved change");
        pendingButton("Review & save…").click();
        pendingButton("Discard…").click();
        expect(drafts.reviewAndSave).toHaveBeenCalledOnce();
        expect(drafts.discardChanges).toHaveBeenCalledOnce();
    });
});

describe("plugin table selection and row menu", () => {
    it("selects rows like a file explorer", () => {
        const { rowOf } = setup();
        rowOf("Beta").click();
        rowOf("Gamma").dispatchEvent(new MouseEvent("click", { shiftKey: true }));
        expect(["Beta", "Alpha", "Gamma"].map((name) => rowOf(name).classList.contains("is-selected"))).toEqual([true, true, true]);
        rowOf("Alpha").dispatchEvent(new MouseEvent("click", { ctrlKey: true }));
        expect(rowOf("Alpha").classList.contains("is-selected")).toBe(false);

        const shiftDown = new MouseEvent("mousedown", { shiftKey: true, cancelable: true });
        rowOf("Alpha").dispatchEvent(shiftDown);
        expect(shiftDown.defaultPrevented).toBe(true);
    });

    it("does not change the selection when a mode is edited", () => {
        const { rowOf } = setup();
        rowOf("Alpha").querySelector<HTMLElement>(".lazy-plugin-table-mode-cell")!.click();
        expect(rowOf("Alpha").classList.contains("is-selected")).toBe(false);
    });

    it("offers the single-plugin actions for one row", async () => {
        Platform.isDesktopApp = true;
        const { rowOf, app, openLazyOptions } = setup();
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

        let menu = rightClick(rowOf("Beta"));
        expect(menu.find("Lazy settings")!.disabled).toBe(true);
        menu.find("Open plugin settings")!.click();
        expect(app.setting.openTabById).toHaveBeenCalledWith("beta");
        menu.find("Show in community plugins")!.click();
        expect(showInCommunityPlugins).toHaveBeenCalledWith(app, "beta");
        menu.find("Show in system explorer")!.click();
        expect(openPluginDirectory).toHaveBeenCalledWith(app, expect.objectContaining({ id: "beta" }));
        menu.find("Plugin ID")!.click();
        await flush();
        expect(writeText).toHaveBeenLastCalledWith("beta");
        expect(Notice.messages).toContain("Copied: beta");
        menu.find("Relative path")!.click();
        await flush();
        expect(writeText).toHaveBeenLastCalledWith("config/plugins/beta");
        // Only the desktop adapter can resolve an absolute path.
        expect(menu.find("Absolute path")).toBeUndefined();

        menu = rightClick(rowOf("Alpha"));
        expect(menu.find("Open plugin settings")).toBeUndefined();
        menu.find("Lazy settings")!.click();
        expect(openLazyOptions).toHaveBeenCalledWith("alpha", expect.any(Function));
        // A plugin without a folder offers only its ID.
        expect(rightClick(rowOf("Gamma")).find("Relative path")).toBeUndefined();
    });

    it("applies a mode to every selected row from the menu", () => {
        const { rowOf, select, drafts } = setup();
        rowOf("Alpha").click();
        rowOf("Gamma").dispatchEvent(new MouseEvent("click", { ctrlKey: true }));
        const menu = rightClick(rowOf("Gamma"));
        expect(menu.find("Mode for 2 plugins")).toBeDefined();
        expect(menu.find("Lazy settings")).toBeUndefined();

        menu.find("🚀 Lazy on layout ready")!.click();

        expect(select(rowOf("Alpha")).value).toBe(PLUGIN_MODE.LAZY_ON_LAYOUT_READY);
        expect(select(rowOf("Gamma")).value).toBe(PLUGIN_MODE.LAZY_ON_LAYOUT_READY);
        expect([...drafts.pendingPluginIds].sort()).toEqual(["alpha", "gamma"]);
        expect(rightClick(rowOf("Gamma")).find("🚀 Lazy on layout ready")!.checked).toBe(true);
    });

    it("copies several IDs and absolute paths, and reports a failed copy", async () => {
        const { rowOf, app } = setup();
        app.vault.adapter = new FileSystemAdapter();
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        rowOf("Alpha").click();
        rowOf("Beta").dispatchEvent(new MouseEvent("click", { ctrlKey: true }));

        const menu = rightClick(rowOf("Alpha"));
        menu.find("Plugin IDs")!.click();
        await flush();
        expect(writeText).toHaveBeenLastCalledWith("beta\nalpha");
        expect(Notice.messages).toContain("Copied 2 lines");
        menu.find("Absolute paths")!.click();
        await flush();
        expect(writeText).toHaveBeenLastCalledWith("vault/config/plugins/beta\nvault/config/plugins/alpha");

        writeText.mockRejectedValueOnce(new Error("denied"));
        menu.find("Relative paths")!.click();
        await flush();
        expect(Notice.messages).toContain("Failed to copy to clipboard");
    });
});

describe("plugin table edge cases", () => {
    it("shows blank cells for a manifest without an author or description", () => {
        const { rowOf } = setup({ extra: [{ id: "delta", name: "Delta", version: "4.0.0" } as PluginManifest] });
        const delta = rowOf("Delta");
        expect(delta.querySelector(".lazy-plugin-table-author")).toBeNull();
        expect(delta.querySelector(".lazy-plugin-table-col-description")?.textContent).toBe("");
    });

    it("lets a plain mousedown through for text selection", () => {
        const { rowOf } = setup();
        const down = new MouseEvent("mousedown", { cancelable: true });
        rowOf("Alpha").dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
    });

    it("ignores a dropdown value that is not a mode", () => {
        const { rowOf, select, drafts } = setup();
        const dropdown = select(rowOf("Alpha"));
        dropdown.createEl("option", { value: "bogus", text: "Bogus" });
        change(dropdown, "bogus");
        expect(drafts.markDirty).not.toHaveBeenCalled();
    });

    it("applies a mode from the menu while the mode column is hidden", () => {
        const { rowOf, header, drafts, root } = setup();
        rightClick(header("mode")).find("Columns")!.submenu!.find("Mode")!.click();
        expect(root.querySelector(".lazy-plugin-table-mode-cell")).toBeNull();

        rightClick(rowOf("Alpha")).find("✅ Always enabled")!.click();

        expect(drafts.pendingPluginIds.has("alpha")).toBe(true);
    });

    it("offers only the column list for a header that cannot sort", () => {
        const { root } = setup({ touch: true });
        const menu = rightClick(root.querySelector<HTMLElement>("thead .lazy-plugin-table-th.lazy-plugin-table-col-actions")!);
        expect(menu.items.map((item) => item.title)).toEqual(["Columns"]);
    });

    it("copies the absolute path of a single plugin on desktop", async () => {
        const { rowOf, app } = setup();
        app.vault.adapter = new FileSystemAdapter();
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        rightClick(rowOf("Alpha")).find("Absolute path")!.click();
        await flush();
        expect(writeText).toHaveBeenLastCalledWith("vault/config/plugins/alpha");
    });
});
