import type { PluginUpdateManifest } from "@obsidian-typings/obsidian-public-latest";
import {
    columnFilteringFeature,
    columnVisibilityFeature,
    constructTable,
    createColumnHelper,
    createFilteredRowModel,
    createSortedRowModel,
    filterFn_includesString,
    functionalUpdate,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    tableFeatures,
} from "@tanstack/table-core";
import type { ColumnFiltersState, FilterFn, SortFn, SortingState, Table } from "@tanstack/table-core";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";
import type { Debouncer, MenuItem, Menu as MenuType, PluginManifest } from "obsidian";
import { ButtonComponent, DropdownComponent, ExtraButtonComponent, FileSystemAdapter, Menu, Notice, Platform, debounce, setIcon, setTooltip } from "obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { PLUGIN_MODE, PluginModes, isPluginMode } from "src/core/types";
import { isPluginLoaded } from "src/core/utils";
import type { PluginTableHost } from "src/features/plugin-table/plugin-table-host";
import { RowSelection } from "src/features/plugin-table/row-selection";
import type { PluginTableState } from "src/features/plugin-table/table-state";
import { MIN_COLUMN_WIDTH } from "src/features/plugin-table/table-state";
import { pendingSummary } from "src/ui/drafts/draft-session";
import { addModeOptions, enabledBadgeText, openPluginDirectory } from "src/ui/settings/helpers";
import { showInCommunityPlugins } from "src/ui/show-in-community-plugins";

export interface PluginTableRow {
    id: string;
    name: string;
    version: string;
    /** Newer version found by Obsidian's update check, if any. */
    latestVersion?: string;
    author: string;
    description: string;
    dir?: string;
    /** Live runtime state; the staged mode alone cannot tell whether a lazy plugin is loaded now. */
    loaded: boolean;
    /** Loaded although community-plugins.json does not list it, so it will not load after a restart. */
    memoryOnly: boolean;
    status: string;
    mode: PLUGIN_MODE;
    /** On-Demand itself: always loaded from community-plugins.json, and its mode is not editable here. */
    locked: boolean;
}

const MODE_ORDER: PLUGIN_MODE[] = [PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.LAZY, PLUGIN_MODE.LAZY_ON_LAYOUT_READY, PLUGIN_MODE.ALWAYS_ENABLED];

const features = tableFeatures({
    coreReactivityFeature: storeReactivityBindings(),
    columnFilteringFeature,
    filteredRowModel: createFilteredRowModel(),
    filterFns: { includesString: filterFn_includesString },
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
    columnVisibilityFeature,
});

type Features = typeof features;
type TableColumn = ReturnType<Table<Features, PluginTableRow>["getAllLeafColumns"]>[number];

const helper = createColumnHelper<Features, PluginTableRow>();

/** Select filters hold the exact value as a string; choosing "All" removes the filter instead. */
const equalsFilterFn: FilterFn<Features, PluginTableRow> = (row, columnId, filterValue) => String(row.getValue(columnId)) === String(filterValue);

/**
 * "true" and "false" are what the Loaded and Not loaded summary items set; "saved" and
 * "memory" split the loaded plugins by whether community-plugins.json lists them.
 */
const loadedFilterFn: FilterFn<Features, PluginTableRow> = (row, _columnId, filterValue) => {
    const { loaded, memoryOnly } = row.original;
    switch (filterValue) {
        case "saved":
            return loaded && !memoryOnly;
        case "memory":
            return memoryOnly;
        default:
            return String(loaded) === String(filterValue);
    }
};

/** The author sits beside the name, so the name filter finds plugins by either. */
const nameFilterFn: FilterFn<Features, PluginTableRow> = (row, _columnId, filterValue) => {
    const query = String(filterValue).toLowerCase();
    return row.original.name.toLowerCase().includes(query) || row.original.author.toLowerCase().includes(query);
};

/** Sort modes from the most to the least restrictive, matching the row menu, not alphabetically. */
const modeSortFn: SortFn<Features, PluginTableRow> = (rowA, rowB) => MODE_ORDER.indexOf(rowA.original.mode) - MODE_ORDER.indexOf(rowB.original.mode);

const columns = helper.columns([
    helper.accessor("name", { header: "Name", filterFn: nameFilterFn, sortFn: "alphanumeric", enableHiding: false }),
    helper.accessor("id", { header: "ID", filterFn: "includesString", sortFn: "alphanumeric" }),
    helper.accessor("loaded", { header: "Loaded", filterFn: loadedFilterFn, sortFn: "basic" }),
    helper.accessor("mode", { header: "Mode", filterFn: equalsFilterFn, sortFn: modeSortFn }),
    helper.accessor("description", { header: "Description", filterFn: "includesString", sortFn: "alphanumeric" }),
    // Touch screens have no right-click, so phones and tablets get a visible menu button per row.
    helper.display({ id: "actions", header: "", enableHiding: false, enableSorting: false }),
]);

const TEXT_FILTER_COLUMNS = new Set(["name", "id", "description"]);

const DEFAULT_WIDTHS: Record<string, number> = {
    name: 300,
    id: 180,
    loaded: 90,
    mode: 240,
    actions: 52,
};

/** Columns without a set width (the description) keep at least this much before the table scrolls sideways. */
const UNSIZED_MIN_WIDTH = 240;

const SUMMARY_FILTERS = ["all", "enabled", "disabled", "updates"] as const;
type SummaryFilter = (typeof SUMMARY_FILTERS)[number];

const SUMMARY_LABELS: Record<SummaryFilter, string> = {
    all: "All",
    enabled: "Loaded",
    disabled: "Not loaded",
    updates: "Updates",
};

interface SummaryItem {
    button: HTMLButtonElement;
    count: HTMLElement;
}

/** Controls kept per rendered row so mode edits and load events update cells in place. */
interface RowControls {
    tr: HTMLElement;
    loadedCell?: HTMLElement;
    gear?: ExtraButtonComponent;
    dropdown?: DropdownComponent;
}

function pluralizePlugins(count: number): string {
    return `${count} plugin${count === 1 ? "" : "s"}`;
}

/** Every column here has a plain string header. */
function headerText(column: TableColumn): string {
    return typeof column.columnDef.header === "string" ? column.columnDef.header : "";
}

/** Filters here only ever hold strings; anything else means no filter. */
function filterText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** `MenuItem.setSubmenu` is not in Obsidian's public API, so this is the one place that relies on it. */
function addSubmenu(item: MenuItem): MenuType {
    return (item as unknown as { setSubmenu(): MenuType }).setSubmenu();
}

/** `MenuItem.setDestructive` is missing from the public typings, so fall back to the old warning style if unavailable. */
function markDestructive(item: MenuItem): void {
    const candidate = item as MenuItem & { setDestructive?: () => void };
    if (candidate.setDestructive) candidate.setDestructive();
    else item.setWarning(true);
}

function hasUpdate(row: PluginTableRow): boolean {
    return row.latestVersion !== undefined;
}

/** Makes element IDs unique when more than one table is open. */
let tableCount = 0;

export interface PluginTableOptions {
    initialState: PluginTableState;
    onStateChange: (state: PluginTableState) => void;
}

/**
 * Plugin table built with headless TanStack Table and hand-written DOM. It only
 * edits loading modes, through the shared draft, and never toggles plugins itself.
 */
export class PluginTable {
    private readonly host: PluginTableHost;
    private readonly options: PluginTableOptions;
    private table: Table<Features, PluginTableRow>;
    private rowData: PluginTableRow[] = [];
    private sorting: SortingState;
    private columnFilters: ColumnFiltersState = [];
    private columnVisibility: Record<string, boolean>;
    private columnWidths: Record<string, number>;
    /** Narrows the table to plugins with a pending update. Not persisted, like the column filters. */
    private showUpdatesOnly = false;
    private selection = new RowSelection();
    /** Plugin IDs in on-screen order, used to resolve range selection. */
    private visibleIds: string[] = [];
    private rowControls = new Map<string, RowControls>();
    /** community-plugins.json as last read, so "in memory only" can be told apart from a saved enable. */
    private savedCommunityPluginIds?: Set<string>;
    private communityPluginReadId = 0;

    private containerEl: HTMLElement;
    private summaryItems: Record<SummaryFilter, SummaryItem>;
    private pendingEl: HTMLElement;
    private tableEl: HTMLTableElement;
    private colgroupEl: HTMLTableColElement;
    private theadEl: HTMLTableSectionElement;
    private tbodyEl: HTMLTableSectionElement;
    private saveState: Debouncer<[], void>;
    private stopResize?: () => void;
    /** Touch layouts get a menu button per row, since they have no right-click. */
    private readonly touchUi: boolean;
    /**
     * Controls are named with aria-labelledby, pointing at the header and name text already
     * on screen: Obsidian shows any aria-label as a tooltip, which these controls do not need.
     */
    private readonly idPrefix = `lazy-plugin-table-${++tableCount}`;

    constructor(host: HTMLElement, tableHost: PluginTableHost, options: PluginTableOptions) {
        this.host = tableHost;
        this.options = options;
        // Obsidian marks mobile layouts on the body, including its mobile emulation, which Platform does not follow.
        this.touchUi = host.doc.body.hasClass("is-mobile");
        this.sorting = options.initialState.sorting;
        // The actions column follows the device, so a state saved on one device never hides it on another.
        this.columnVisibility = { ...options.initialState.columnVisibility, actions: this.touchUi };
        this.columnWidths = { ...options.initialState.columnWidths };
        this.rowData = this.buildRows();

        this.containerEl = host.createDiv({ cls: "lazy-plugin-table-container" });

        const summary = this.containerEl.createDiv({ cls: "lazy-plugin-table-summary" });
        const filters = summary.createDiv({ cls: "lazy-plugin-table-summary-filters" });
        const makeItem = (filter: SummaryFilter): SummaryItem => {
            const button = filters.createEl("button", { cls: `lazy-plugin-table-summary-item lazy-plugin-table-summary-item-${filter}` });
            button.createSpan({ text: SUMMARY_LABELS[filter] });
            const count = button.createEl("strong", { text: "0" });
            button.addEventListener("click", () => this.applySummaryFilter(this.getSummaryFilter() === filter ? "all" : filter));
            return { button, count };
        };
        this.summaryItems = { all: makeItem("all"), enabled: makeItem("enabled"), disabled: makeItem("disabled"), updates: makeItem("updates") };
        // Right-aligned opposite the filters, so saving sits where the settings bar puts it.
        this.pendingEl = summary.createDiv({ cls: "lazy-plugin-table-pending" });

        const wrapper = this.containerEl.createDiv({ cls: "lazy-plugin-table-wrapper" });
        this.tableEl = wrapper.createEl("table", { cls: "lazy-plugin-table" });
        this.colgroupEl = this.tableEl.createEl("colgroup");
        this.theadEl = this.tableEl.createEl("thead");
        this.tbodyEl = this.tableEl.createEl("tbody");

        this.saveState = debounce(() => this.options.onStateChange({ sorting: this.sorting, columnVisibility: this.columnVisibility, columnWidths: this.columnWidths }), 500, true);

        this.table = constructTable({
            features,
            columns,
            data: this.getTableData(),
            getRowId: (row) => row.id,
            autoResetAll: false,
            enableMultiSort: false,
            enableSortingRemoval: true,
            state: { sorting: this.sorting, columnFilters: this.columnFilters, columnVisibility: this.columnVisibility },
            onSortingChange: (updater) => {
                this.sorting = functionalUpdate(updater, this.sorting);
                this.syncOptions();
                this.renderHead();
                this.renderBody();
                this.saveState();
            },
            onColumnFiltersChange: (updater) => {
                this.columnFilters = functionalUpdate(updater, this.columnFilters);
                this.syncOptions();
                this.renderBody();
                this.updateSummary();
            },
            onColumnVisibilityChange: (updater) => {
                this.columnVisibility = { ...functionalUpdate(updater, this.columnVisibility), actions: this.touchUi };
                this.syncOptions();
                this.renderHead();
                this.renderBody();
                this.saveState();
            },
        });

        this.renderHead();
        this.renderBody();
        this.updateSummary();
        this.renderPendingBar();
        void this.refreshCommunityPluginSnapshot();
    }

    /** Re-read the plugins and the draft, e.g. after a save, a discard or an install. */
    refresh(): void {
        this.rowData = this.buildRows();
        // Leave the updates view once nothing is left to update, so the table does not stay empty.
        if (!this.rowData.some(hasUpdate)) this.showUpdatesOnly = false;
        this.syncOptions();
        this.renderBody();
        this.updateSummary();
        this.renderPendingBar();
        void this.refreshCommunityPluginSnapshot();
    }

    /** Lazy loads and toggles from elsewhere change only the live state, so update those cells in place. */
    refreshLoadState(): void {
        this.rowData = this.rowData.map((row) => ({ ...row, ...this.loadState(row.id) }));
        this.syncOptions();
        for (const row of this.rowData) this.renderLoadedCell(row);
        this.updateSummary();
    }

    /** Only the draft bar changes when another surface edits the draft in place. */
    refreshPendingBar(): void {
        this.renderPendingBar();
    }

    destroy(): void {
        this.stopResize?.();
        // A sort, column or width change made just before closing would otherwise be lost.
        this.saveState.run();
        this.communityPluginReadId++;
        this.containerEl.remove();
    }

    private buildRows(): PluginTableRow[] {
        // obsidian-typings declares this as a Map, but Obsidian stores a plain object.
        const updates = this.host.app.plugins.updates as unknown as Record<string, PluginUpdateManifest | undefined>;
        return this.host.getManifests().map((manifest: PluginManifest) => {
            const locked = manifest.id === this.host.selfId;
            return {
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                latestVersion: updates[manifest.id]?.version,
                author: manifest.author?.trim() ?? "",
                description: manifest.description,
                dir: manifest.dir,
                // On-Demand has no entry of its own: it loads at startup to apply everyone else's mode.
                mode: locked ? PLUGIN_MODE.ALWAYS_ENABLED : this.host.getMode(manifest.id),
                locked,
                ...this.loadState(manifest.id),
            };
        });
    }

    private loadState(pluginId: string): Pick<PluginTableRow, "loaded" | "memoryOnly" | "status"> {
        // The table is On-Demand's own view, so On-Demand is running and listed whenever it is open.
        if (pluginId === this.host.selfId) return { loaded: true, memoryOnly: false, status: "Loaded" };
        const loaded = isPluginLoaded(this.host.app, pluginId);
        const saved = this.savedCommunityPluginIds;
        return { loaded, memoryOnly: loaded && saved !== undefined && !saved.has(pluginId), status: enabledBadgeText(this.host.app, pluginId, saved) };
    }

    private async refreshCommunityPluginSnapshot() {
        const readId = ++this.communityPluginReadId;
        let parsed: unknown;
        try {
            parsed = await this.host.app.vault.readConfigJson("community-plugins");
        } catch {
            parsed = undefined;
        }
        if (readId !== this.communityPluginReadId) return;
        this.savedCommunityPluginIds = Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string") ? new Set(parsed) : undefined;
        this.refreshLoadState();
    }

    private syncOptions(): void {
        this.table.setOptions((prev) => ({
            ...prev,
            data: this.getTableData(),
            state: { ...prev.state, sorting: this.sorting, columnFilters: this.columnFilters, columnVisibility: this.columnVisibility },
        }));
    }

    private getTableData(): PluginTableRow[] {
        return this.showUpdatesOnly ? this.rowData.filter(hasUpdate) : this.rowData;
    }

    /**
     * The summary item matching the current filters; the updates view takes precedence.
     * Null when the loaded filter narrows further than any item, so none is highlighted.
     */
    private getSummaryFilter(): SummaryFilter | null {
        if (this.showUpdatesOnly) return "updates";
        const loadedFilter = this.columnFilters.find((filter) => filter.id === "loaded")?.value;
        if (loadedFilter === "true") return "enabled";
        if (loadedFilter === "false") return "disabled";
        return loadedFilter === undefined ? "all" : null;
    }

    /**
     * Summary items act as exclusive filters. Loaded/Not loaded reuse the loaded
     * column filter so the select in the filter row stays in sync.
     */
    private applySummaryFilter(filter: SummaryFilter): void {
        this.showUpdatesOnly = filter === "updates";
        const otherFilters = this.columnFilters.filter((f) => f.id !== "loaded");
        this.columnFilters = filter === "enabled" || filter === "disabled" ? [...otherFilters, { id: "loaded", value: String(filter === "enabled") }] : otherFilters;
        this.syncOptions();
        this.renderHead();
        this.renderBody();
        this.updateSummary();
    }

    private updateSummary(): void {
        const loaded = this.rowData.filter((row) => row.loaded).length;
        const counts: Record<SummaryFilter, number> = {
            all: this.rowData.length,
            enabled: loaded,
            disabled: this.rowData.length - loaded,
            updates: this.rowData.filter(hasUpdate).length,
        };
        const active = this.getSummaryFilter();
        for (const filter of SUMMARY_FILTERS) {
            const { button, count } = this.summaryItems[filter];
            count.setText(String(counts[filter]));
            button.toggleClass("is-active", filter === active);
            button.setAttr("aria-pressed", String(filter === active));
        }
        this.summaryItems.updates.button.toggle(counts.updates > 0);
    }

    private renderPendingBar(): void {
        const drafts = this.host.drafts;
        this.pendingEl.empty();
        // Like the settings bar, the controls appear only while there is something to save.
        if (!drafts.hasPendingChanges) return;
        this.pendingEl.createSpan({ cls: "lazy-plugin-table-pending-text" }).append(pendingSummary(drafts.describeChanges()));
        // The handlers stay synchronous so Obsidian does not keep a spinner on the button for the whole review.
        new ButtonComponent(this.pendingEl)
            .setButtonText("Review & save…")
            .setCta()
            .onClick(() => void drafts.reviewAndSave());
        new ButtonComponent(this.pendingEl).setButtonText("Discard…").onClick(() => void drafts.discardChanges());
    }

    private headerId(columnId: string): string {
        return `${this.idPrefix}-header-${columnId}`;
    }

    private nameId(pluginId: string): string {
        return `${this.idPrefix}-name-${pluginId}`;
    }

    private getWidth(id: string): number | undefined {
        return this.columnWidths[id] ?? DEFAULT_WIDTHS[id];
    }

    private renderHead(): void {
        this.colgroupEl.empty();
        this.theadEl.empty();
        const visibleColumns = this.table.getVisibleLeafColumns();

        for (const column of visibleColumns) {
            const col = this.colgroupEl.createEl("col");
            const width = this.getWidth(column.id);
            if (width !== undefined) col.style.width = `${width}px`;
        }
        this.updateMinWidth();

        const headerRow = this.theadEl.createEl("tr");
        visibleColumns.forEach((column, index) => {
            const th = headerRow.createEl("th", { cls: `lazy-plugin-table-th lazy-plugin-table-col-${column.id}` });
            const label = th.createDiv({ cls: "lazy-plugin-table-th-label" });
            label.createSpan({ text: headerText(column), attr: { id: this.headerId(column.id) } });
            const sorted = column.getIsSorted();
            if (sorted) label.createSpan({ text: sorted === "desc" ? " ▼" : " ▲", cls: "lazy-plugin-table-sort-indicator" });
            if (column.getCanSort()) {
                th.addEventListener("click", (evt) => {
                    if ((evt.target as HTMLElement).closest(".lazy-plugin-table-resizer")) return;
                    column.toggleSorting();
                });
            }
            th.addEventListener("contextmenu", (evt) => {
                evt.preventDefault();
                this.showHeaderMenu(evt, column);
            });
            if (column.id === "actions") return;
            const resizer = th.createDiv({ cls: "lazy-plugin-table-resizer" });
            // Pointer events so the columns can also be resized by touch.
            resizer.addEventListener("pointerdown", (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.beginResize(column.id, index, resizer, evt);
            });
        });

        const filterRow = this.theadEl.createEl("tr", { cls: "lazy-plugin-table-filter-row" });
        for (const column of visibleColumns) {
            const th = filterRow.createEl("th");
            if (column.id === "loaded") {
                this.createFilterSelect(th, column, [
                    ["true", "Yes"],
                    // A select cannot be indented with CSS, so the two kinds of Yes are indented with spaces.
                    ["saved", "   Saved"],
                    ["memory", "   In memory only"],
                    ["false", "No"],
                ]);
            } else if (column.id === "mode") {
                this.createFilterSelect(
                    th,
                    column,
                    MODE_ORDER.map((mode) => [mode, PluginModes[mode]]),
                );
            } else if (TEXT_FILTER_COLUMNS.has(column.id)) {
                const wrap = th.createDiv({ cls: "lazy-plugin-table-filter-wrap" });
                const input = wrap.createEl("input", { type: "text", cls: "lazy-plugin-table-filter-input", attr: { placeholder: "Filter...", "aria-labelledby": this.headerId(column.id) } });
                const clear = wrap.createDiv({ cls: "lazy-plugin-table-filter-clear", attr: { role: "button", "aria-label": "Clear filter" } });
                setIcon(clear, "x");
                const syncClear = () => clear.toggleClass("is-hidden", input.value === "");
                input.value = filterText(column.getFilterValue());
                syncClear();
                input.addEventListener("input", () => {
                    column.setFilterValue(input.value === "" ? undefined : input.value);
                    syncClear();
                });
                input.addEventListener("contextmenu", (evt) => evt.stopPropagation());
                clear.addEventListener("click", () => {
                    input.value = "";
                    column.setFilterValue(undefined);
                    syncClear();
                    input.focus();
                });
            }
        }
    }

    /**
     * With a fixed layout the table fits its container, so columns past the edge are squeezed
     * instead of scrolled to. A minimum of the set widths makes it scroll sideways instead.
     */
    private updateMinWidth(): void {
        const widths = this.table.getVisibleLeafColumns().map((column) => this.getWidth(column.id) ?? UNSIZED_MIN_WIDTH);
        this.tableEl.style.minWidth = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    }

    private createFilterSelect(th: HTMLElement, column: TableColumn, options: [string, string][]) {
        const select = th.createEl("select", { cls: "dropdown lazy-plugin-table-filter-input", attr: { "aria-labelledby": this.headerId(column.id) } });
        select.createEl("option", { text: "All", value: "" });
        for (const [value, label] of options) select.createEl("option", { text: label, value });
        select.value = filterText(column.getFilterValue());
        select.addEventListener("change", () => column.setFilterValue(select.value === "" ? undefined : select.value));
    }

    private renderBody(): void {
        this.tbodyEl.empty();
        const rows = this.table.getRowModel().rows;
        this.visibleIds = rows.map((row) => row.id);
        this.selection.retain(this.visibleIds);
        this.rowControls.clear();

        for (const row of rows) {
            const data = row.original;
            const tr = this.tbodyEl.createEl("tr");
            tr.toggleClass("is-loaded", data.loaded);
            tr.toggleClass("is-selected", this.selection.has(data.id));
            const controls: RowControls = { tr };
            this.rowControls.set(data.id, controls);
            tr.addEventListener("mousedown", (evt) => {
                // Keep Shift+click from selecting text across rows.
                if (evt.shiftKey) evt.preventDefault();
            });
            tr.addEventListener("click", (evt) => {
                this.selection.select(data.id, this.visibleIds, { toggle: evt.ctrlKey || evt.metaKey, range: evt.shiftKey });
                this.syncSelection();
            });
            tr.addEventListener("contextmenu", (evt) => {
                evt.preventDefault();
                this.selection.selectForContextMenu(data.id);
                this.syncSelection();
                this.buildRowMenu().showAtMouseEvent(evt);
            });

            for (const cell of row.getVisibleCells()) {
                const td = tr.createEl("td", { cls: `lazy-plugin-table-td lazy-plugin-table-col-${cell.column.id}` });
                switch (cell.column.id) {
                    case "name":
                        this.renderNameCell(td, data);
                        break;
                    case "loaded":
                        controls.loadedCell = td;
                        this.renderLoadedCell(data);
                        break;
                    case "mode":
                        this.renderModeCell(td, data, controls);
                        break;
                    case "actions":
                        this.renderActionsCell(td, data);
                        break;
                    default: {
                        const value = cell.getValue();
                        // The remaining columns are the plain text fields.
                        const text = typeof value === "string" ? value : "";
                        td.setText(text);
                    }
                }
            }
        }
    }

    /** Reflect the selection on rendered rows without rebuilding the table. */
    private syncSelection(): void {
        for (const [id, { tr }] of this.rowControls) tr.toggleClass("is-selected", this.selection.has(id));
    }

    /**
     * Version and author are shown beside the name, as in Obsidian's settings: neither
     * is worth a column of its own, and the name filter matches the author too.
     */
    private renderNameCell(td: HTMLElement, data: PluginTableRow): void {
        td.createSpan({ cls: "lazy-plugin-table-name", text: data.name, attr: { id: this.nameId(data.id) } });
        const version = td.createSpan({ cls: "lazy-plugin-table-version" });
        if (data.latestVersion) {
            const icon = version.createSpan({ cls: "lazy-plugin-table-update-icon" });
            setIcon(icon, "arrow-big-up-dash");
            setTooltip(icon, `Update available: v${data.latestVersion}`);
        }
        version.appendText(data.version);
        if (data.author) td.createSpan({ cls: "lazy-plugin-table-author", text: data.author });
    }

    /** A lamp and Yes/No; plugins are switched only through their mode. */
    private renderLoadedCell(data: PluginTableRow): void {
        const controls = this.rowControls.get(data.id);
        const td = controls?.loadedCell;
        if (!controls || !td) return;
        controls.tr.toggleClass("is-loaded", data.loaded);
        td.empty();
        const lamp = td.createSpan({ cls: "lazy-plugin-table-lamp", attr: { "aria-hidden": "true" } });
        lamp.toggleClass("is-loaded", data.loaded);
        lamp.toggleClass("is-memory-only", data.memoryOnly);
        // The lamp colour and the tooltip carry the in-memory detail.
        td.createSpan({ text: data.loaded ? "Yes" : "No" });
        setTooltip(td, data.status);
    }

    private renderModeCell(td: HTMLElement, data: PluginTableRow, controls: RowControls): void {
        const wrapper = td.createDiv({ cls: "lazy-plugin-table-mode-cell" });
        if (data.locked) {
            wrapper.createSpan({ cls: "lazy-plugin-table-mode-fixed", text: PluginModes[data.mode] });
            return;
        }
        // Editing a mode is not a row click, so it never changes the selection.
        wrapper.addEventListener("click", (evt) => evt.stopPropagation());
        controls.dropdown = addModeOptions(new DropdownComponent(wrapper))
            .setValue(data.mode)
            .onChange((value) => {
                if (isPluginMode(value)) this.applyMode([data.id], value);
            });
        controls.dropdown.selectEl.setAttr("aria-labelledby", `${this.headerId("mode")} ${this.nameId(data.id)}`);
        // The gear follows the dropdown, as the options belong to the mode chosen there.
        controls.gear = new ExtraButtonComponent(wrapper)
            .setIcon("settings")
            .setTooltip("Lazy settings")
            .onClick(() => this.openLazyOptions(data.id));
        this.syncModeControls(data);
    }

    /** The lazy options only take effect in Lazy on demand, so the gear shows only there. */
    private syncModeControls(data: PluginTableRow): void {
        const controls = this.rowControls.get(data.id);
        if (!controls?.gear || !controls.dropdown) return;
        controls.dropdown.setValue(data.mode);
        const isLazy = data.mode === PLUGIN_MODE.LAZY;
        controls.gear.setDisabled(!isLazy);
        // Hidden but still taking its place, so the dropdowns stay aligned across rows.
        controls.gear.extraSettingsEl.toggleClass("is-disabled", !isLazy);
    }

    private markEdited(pluginId: string): void {
        this.host.drafts.pendingPluginIds.add(pluginId);
        this.host.drafts.markDirty(this);
        this.renderPendingBar();
    }

    private renderActionsCell(td: HTMLElement, data: PluginTableRow): void {
        const button = new ExtraButtonComponent(td).setIcon("ellipsis-vertical").setTooltip("Plugin actions");
        button.extraSettingsEl.addEventListener("click", (evt) => {
            evt.stopPropagation();
            this.selection.selectForContextMenu(data.id);
            this.syncSelection();
            const rect = button.extraSettingsEl.getBoundingClientRect();
            this.buildRowMenu().showAtPosition({ x: rect.left, y: rect.bottom }, button.extraSettingsEl.doc);
        });
    }

    private openLazyOptions(pluginId: string): void {
        this.host.openLazyOptions(pluginId, () => this.markEdited(pluginId));
    }

    /**
     * Stages a mode for each plugin and updates the cells in place, so a row stays
     * where it is even when it no longer matches the filter until the filters change.
     */
    private applyMode(ids: readonly string[], mode: PLUGIN_MODE): void {
        const staged = ids.filter((id) => id !== this.host.selfId && this.host.stageMode(id, mode));
        if (staged.length > 0) {
            for (const id of staged) this.host.drafts.pendingPluginIds.add(id);
            this.host.drafts.markDirty(this);
        }
        const changed = new Set(ids);
        this.rowData = this.rowData.map((row) => (changed.has(row.id) ? { ...row, mode: this.host.getMode(row.id) } : row));
        this.syncOptions();
        for (const row of this.rowData) if (changed.has(row.id)) this.syncModeControls(row);
        this.renderPendingBar();
    }

    private getSelectedRows(): PluginTableRow[] {
        const selected = new Set(this.selection.ids(this.visibleIds));
        // The visible order, so batch actions and copies follow what is on screen.
        return this.table.getRowModel().rows.flatMap((row) => (selected.has(row.id) ? [row.original] : []));
    }

    /** Acts on the selection; opening the menu has already put the row it was opened on into it. */
    private buildRowMenu(): MenuType {
        const targets = this.getSelectedRows();
        const single = targets.length === 1 ? targets[0] : null;
        // On-Demand's own row keeps every action except changing its settings.
        const editable = targets.filter((row) => !row.locked);
        const menu = new Menu();

        if (single && !single.locked) {
            menu.addItem((item) =>
                item
                    .setTitle("Lazy settings")
                    .setIcon("settings")
                    .setDisabled(single.mode !== PLUGIN_MODE.LAZY)
                    .onClick(() => this.openLazyOptions(single.id)),
            );
        }
        if (editable.length > 0) {
            menu.addItem((item) => {
                item.setTitle(single ? "Mode" : `Mode for ${pluralizePlugins(editable.length)}`).setIcon("list-checks");
                const submenu = addSubmenu(item);
                for (const mode of MODE_ORDER) {
                    submenu.addItem((subItem) =>
                        subItem
                            .setTitle(PluginModes[mode])
                            .setChecked(editable.every((row) => row.mode === mode))
                            .onClick(() => this.applyMode(
                                editable.map((row) => row.id),
                                mode,
                            )),
                    );
                }
            });
        }

        if (single) {
            menu.addSeparator();
            if (single.loaded) {
                menu.addItem((item) =>
                    item
                        .setTitle("Open plugin settings")
                        .setIcon("settings-2")
                        .onClick(() => {
                            this.host.app.setting.open();
                            this.host.app.setting.openTabById(single.id);
                        }),
                );
            }
            menu.addItem((item) =>
                item
                    .setTitle("Show in community plugins")
                    .setIcon("list")
                    .onClick(() => showInCommunityPlugins(this.host.app, single.id)),
            );
            if (Platform.isDesktopApp) {
                menu.addItem((item) =>
                    item
                        .setTitle("Show in system explorer")
                        .setIcon("folder-open")
                        .onClick(() => void openPluginDirectory(this.host.app, single)),
                );
            }
        }

        menu.addSeparator();
        this.addCopyItems(menu, targets, single);

        const uninstallable = targets.filter((row) => !row.locked);
        if (this.host.showUninstallInTableMenu() && uninstallable.length > 0) {
            menu.addSeparator();
            menu.addItem((item) => {
                markDestructive(item);
                item.setTitle(single ? "Uninstall plugin" : `Uninstall ${pluralizePlugins(uninstallable.length)}`)
                    .setIcon("trash-2")
                    .onClick(() => void this.uninstallPlugins(uninstallable));
            });
        }
        return menu;
    }

    /** Deletes the plugin folders through Obsidian, after an explicit confirmation. */
    private async uninstallPlugins(rows: readonly PluginTableRow[]): Promise<void> {
        const [first] = rows;
        const message = rows.length === 1
            ? `Uninstall ${first.name}? This removes the plugin and its files from the current vault.`
            : `Uninstall ${pluralizePlugins(rows.length)}? This removes these plugins and their files from the current vault.\n\n${rows.map((row) => row.name).join("\n")}`;
        if ((await showConfirmModal(this.host.app, { message })) !== true) return;

        // Obsidian handles disabling, removing the folder and updating its manifest.
        const plugins = this.host.app.plugins as unknown as { uninstallPlugin?: (pluginId: string) => Promise<void> };
        const failed: string[] = [];
        for (const row of rows) {
            try {
                if (!plugins.uninstallPlugin) throw new Error("Uninstall is unavailable");
                await plugins.uninstallPlugin(row.id);
            } catch (error) {
                console.error(error);
                failed.push(row.name);
            }
        }
        this.refresh();

        if (failed.length > 0) {
            new Notice(`Failed to uninstall ${failed.length === 1 ? failed[0] : pluralizePlugins(failed.length)}`);
            return;
        }
        new Notice(`Uninstalled ${rows.length === 1 ? first.name : pluralizePlugins(rows.length)}`);
    }

    private addCopyItems(menu: MenuType, targets: readonly PluginTableRow[], single: PluginTableRow | null): void {
        const dirs = targets.flatMap((row) => (row.dir ? [row.dir] : []));
        const adapter = this.host.app.vault.adapter;
        // Only the desktop adapter has an OS path to resolve against.
        const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
        menu.addItem((item) => {
            item.setTitle("Copy").setIcon("copy");
            const submenu = addSubmenu(item);
            submenu.addItem((subItem) => subItem.setTitle(single ? "Plugin ID" : "Plugin IDs").onClick(() => void this.copyLines(targets.map((row) => row.id))));
            if (dirs.length === 0) return;
            submenu.addItem((subItem) => subItem.setTitle(single ? "Relative path" : "Relative paths").onClick(() => void this.copyLines(dirs)));
            if (basePath === undefined) return;
            submenu.addItem((subItem) => subItem.setTitle(single ? "Absolute path" : "Absolute paths").onClick(() => void this.copyLines(dirs.map((dir) => `${basePath}/${dir}`))));
        });
    }

    private async copyLines(lines: readonly string[]): Promise<void> {
        const text = lines.join("\n");
        try {
            await navigator.clipboard.writeText(text);
            new Notice(lines.length === 1 ? `Copied: ${text}` : `Copied ${lines.length} lines`);
        } catch {
            new Notice("Failed to copy to clipboard");
        }
    }

    private showHeaderMenu(evt: MouseEvent, column: TableColumn): void {
        const menu = new Menu();
        if (column.getCanSort()) {
            menu.addItem((item) =>
                item
                    .setTitle("Sort ascending")
                    .setIcon("arrow-up")
                    .onClick(() => column.toggleSorting(false, true)),
            );
            menu.addItem((item) =>
                item
                    .setTitle("Sort descending")
                    .setIcon("arrow-down")
                    .onClick(() => column.toggleSorting(true, true)),
            );
            menu.addSeparator();
        }
        menu.addItem((item) => {
            item.setTitle("Columns").setIcon("columns-3");
            const submenu = addSubmenu(item);
            for (const col of this.table.getAllLeafColumns()) {
                if (!col.getCanHide()) continue;
                submenu.addItem((subItem) =>
                    subItem
                        .setTitle(headerText(col))
                        .setChecked(col.getIsVisible())
                        .onClick(() => col.toggleVisibility(!col.getIsVisible())),
                );
            }
        });
        menu.showAtMouseEvent(evt);
    }

    private beginResize(id: string, colIndex: number, handle: HTMLElement, start: PointerEvent): void {
        this.stopResize?.();
        // renderHead creates one col per visible column, so the index always has one.
        const colEl = this.colgroupEl.children[colIndex] as HTMLElement;
        const startWidth = colEl.getBoundingClientRect().width;
        // Capturing keeps the drag going when the pointer leaves the narrow handle.
        handle.setPointerCapture(start.pointerId);
        const onMove = (evt: PointerEvent) => {
            const next = Math.round(Math.max(MIN_COLUMN_WIDTH, startWidth + (evt.clientX - start.clientX)));
            this.columnWidths[id] = next;
            colEl.style.width = `${next}px`;
            this.updateMinWidth();
        };
        const onEnd = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onEnd);
            handle.removeEventListener("pointercancel", onEnd);
            this.stopResize = undefined;
            this.saveState();
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onEnd);
        handle.addEventListener("pointercancel", onEnd);
        this.stopResize = onEnd;
    }
}
