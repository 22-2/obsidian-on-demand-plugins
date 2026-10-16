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
import type { Menu as MenuType, PluginManifest } from "obsidian";
import { ButtonComponent, DropdownComponent, ExtraButtonComponent, FileSystemAdapter, Menu, Notice, Platform, debounce, setIcon, setTooltip } from "obsidian";
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
    enabled: boolean;
    /** Loaded although community-plugins.json does not list it, so it will not load after a restart. */
    memoryOnly: boolean;
    status: string;
    mode: PLUGIN_MODE;
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

/** Sort modes from the most to the least restrictive, matching the row menu, not alphabetically. */
const modeSortFn: SortFn<Features, PluginTableRow> = (rowA, rowB) => MODE_ORDER.indexOf(rowA.original.mode) - MODE_ORDER.indexOf(rowB.original.mode);

const columns = helper.columns([
    helper.accessor("name", { header: "Name", filterFn: "includesString", sortFn: "alphanumeric", enableHiding: false }),
    helper.accessor("id", { header: "ID", filterFn: "includesString", sortFn: "alphanumeric" }),
    helper.accessor("author", { header: "Author", filterFn: "includesString", sortFn: "alphanumeric" }),
    helper.accessor("enabled", { header: "Enabled", filterFn: equalsFilterFn, sortFn: "basic" }),
    helper.accessor("mode", { header: "Mode", filterFn: equalsFilterFn, sortFn: modeSortFn }),
    helper.accessor("description", { header: "Description", filterFn: "includesString", sortFn: "alphanumeric" }),
    // Touch screens have no right-click, so phones and tablets get a visible menu button per row.
    helper.display({ id: "actions", header: "", enableHiding: false, enableSorting: false }),
]);

const TEXT_FILTER_COLUMNS = new Set(["name", "id", "author", "description"]);

const DEFAULT_WIDTHS: Record<string, number> = {
    name: 240,
    author: 140,
    enabled: 130,
    mode: 250,
    actions: 52,
};

const SUMMARY_FILTERS = ["all", "enabled", "disabled", "updates"] as const;
type SummaryFilter = (typeof SUMMARY_FILTERS)[number];

const SUMMARY_LABELS: Record<SummaryFilter, string> = {
    all: "All",
    enabled: "Enabled",
    disabled: "Disabled",
    updates: "Updates",
};

interface SummaryItem {
    button: HTMLButtonElement;
    count: HTMLElement;
}

/** Controls kept per rendered row so mode edits and load events update cells in place. */
interface RowControls {
    tr: HTMLElement;
    enabledCell?: HTMLElement;
    gear?: ExtraButtonComponent;
    dropdown?: DropdownComponent;
}

/** Only multi-row actions show a count; a single row gets its own wording. */
function pluralizePlugins(count: number): string {
    return `${count} plugins`;
}

/** Every column here has a plain string header. */
function headerText(column: TableColumn): string {
    return typeof column.columnDef.header === "string" ? column.columnDef.header : "";
}

/** Filters here only ever hold strings; anything else means no filter. */
function filterText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function hasUpdate(row: PluginTableRow): boolean {
    return row.latestVersion !== undefined;
}

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
    private colgroupEl: HTMLTableColElement;
    private theadEl: HTMLTableSectionElement;
    private tbodyEl: HTMLTableSectionElement;
    private saveState: () => void;
    private stopResize?: () => void;
    /** Touch layouts get a menu button per row, since they have no right-click. */
    private readonly touchUi: boolean;

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
        const tableEl = wrapper.createEl("table", { cls: "lazy-plugin-table" });
        this.colgroupEl = tableEl.createEl("colgroup");
        this.theadEl = tableEl.createEl("thead");
        this.tbodyEl = tableEl.createEl("tbody");

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
        for (const row of this.rowData) this.renderEnabledCell(row);
        this.updateSummary();
    }

    /** Only the draft bar changes when another surface edits the draft in place. */
    refreshPendingBar(): void {
        this.renderPendingBar();
    }

    destroy(): void {
        this.stopResize?.();
        this.communityPluginReadId++;
        this.containerEl.remove();
    }

    private buildRows(): PluginTableRow[] {
        // obsidian-typings declares this as a Map, but Obsidian stores a plain object.
        const updates = this.host.app.plugins.updates as unknown as Record<string, PluginUpdateManifest | undefined>;
        return this.host.getManifests().map((manifest: PluginManifest) => ({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            latestVersion: updates[manifest.id]?.version,
            author: manifest.author?.trim() ?? "",
            description: manifest.description,
            dir: manifest.dir,
            mode: this.host.getMode(manifest.id),
            ...this.loadState(manifest.id),
        }));
    }

    private loadState(pluginId: string): Pick<PluginTableRow, "enabled" | "memoryOnly" | "status"> {
        const enabled = isPluginLoaded(this.host.app, pluginId);
        const saved = this.savedCommunityPluginIds;
        return { enabled, memoryOnly: enabled && saved !== undefined && !saved.has(pluginId), status: enabledBadgeText(this.host.app, pluginId, saved) };
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

    /** The summary item matching the current filters; the updates view takes precedence. */
    private getSummaryFilter(): SummaryFilter {
        if (this.showUpdatesOnly) return "updates";
        const enabledFilter = this.columnFilters.find((filter) => filter.id === "enabled")?.value;
        if (enabledFilter === "true") return "enabled";
        if (enabledFilter === "false") return "disabled";
        return "all";
    }

    /**
     * Summary items act as exclusive filters. Enabled/Disabled reuse the enabled
     * column filter so the select in the filter row stays in sync.
     */
    private applySummaryFilter(filter: SummaryFilter): void {
        this.showUpdatesOnly = filter === "updates";
        const otherFilters = this.columnFilters.filter((f) => f.id !== "enabled");
        this.columnFilters = filter === "enabled" || filter === "disabled" ? [...otherFilters, { id: "enabled", value: String(filter === "enabled") }] : otherFilters;
        this.syncOptions();
        this.renderHead();
        this.renderBody();
        this.updateSummary();
    }

    private updateSummary(): void {
        const enabled = this.rowData.filter((row) => row.enabled).length;
        const counts: Record<SummaryFilter, number> = {
            all: this.rowData.length,
            enabled,
            disabled: this.rowData.length - enabled,
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
        const hasChanges = drafts.hasPendingChanges;
        this.pendingEl.empty();
        this.pendingEl.toggleClass("has-pending-changes", hasChanges);
        const text = this.pendingEl.createSpan({ cls: "lazy-plugin-table-pending-text" });
        if (hasChanges) text.append(pendingSummary(drafts.describeChanges()));
        else text.setText("No unsaved changes");
        // The handlers stay synchronous so Obsidian does not keep a spinner on the button for the whole review.
        new ButtonComponent(this.pendingEl)
            .setButtonText("Review & save…")
            .setCta()
            .setDisabled(!hasChanges)
            .onClick(() => void drafts.reviewAndSave());
        new ButtonComponent(this.pendingEl)
            .setButtonText("Discard…")
            .setDisabled(!hasChanges)
            .onClick(() => void drafts.discardChanges());
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

        const headerRow = this.theadEl.createEl("tr");
        visibleColumns.forEach((column, index) => {
            const th = headerRow.createEl("th", { cls: `lazy-plugin-table-th lazy-plugin-table-col-${column.id}` });
            const label = th.createDiv({ cls: "lazy-plugin-table-th-label" });
            label.createSpan({ text: headerText(column) });
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
            if (column.id === "enabled") {
                this.createFilterSelect(th, column, [
                    ["true", "Enabled"],
                    ["false", "Disabled"],
                ]);
            } else if (column.id === "mode") {
                this.createFilterSelect(
                    th,
                    column,
                    MODE_ORDER.map((mode) => [mode, PluginModes[mode]]),
                );
            } else if (TEXT_FILTER_COLUMNS.has(column.id)) {
                const input = th.createEl("input", { type: "text", cls: "lazy-plugin-table-filter-input", attr: { placeholder: "Filter...", "aria-label": `Filter ${headerText(column)}` } });
                input.value = filterText(column.getFilterValue());
                input.addEventListener("input", () => column.setFilterValue(input.value === "" ? undefined : input.value));
                input.addEventListener("contextmenu", (evt) => evt.stopPropagation());
            }
        }
    }

    private createFilterSelect(th: HTMLElement, column: TableColumn, options: [string, string][]) {
        const select = th.createEl("select", { cls: "dropdown lazy-plugin-table-filter-input", attr: { "aria-label": `Filter ${headerText(column)}` } });
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
            tr.toggleClass("is-loaded", data.enabled);
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
                    case "enabled":
                        controls.enabledCell = td;
                        this.renderEnabledCell(data);
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
                        td.title = text;
                    }
                }
            }
        }
    }

    /** Reflect the selection on rendered rows without rebuilding the table. */
    private syncSelection(): void {
        for (const [id, { tr }] of this.rowControls) tr.toggleClass("is-selected", this.selection.has(id));
    }

    /** Version is shown beside the name, as in Obsidian's settings, since it is not worth sorting or filtering by. */
    private renderNameCell(td: HTMLElement, data: PluginTableRow): void {
        td.createSpan({ cls: "lazy-plugin-table-name", text: data.name });
        td.title = data.name;
        const version = td.createSpan({ cls: "lazy-plugin-table-version" });
        if (data.latestVersion) {
            const icon = version.createSpan({ cls: "lazy-plugin-table-update-icon" });
            setIcon(icon, "arrow-big-up-dash");
            setTooltip(icon, `Update available: v${data.latestVersion}`);
        }
        version.appendText(data.version);
    }

    /** A lamp and the state, like the settings list; plugins are switched only through their mode. */
    private renderEnabledCell(data: PluginTableRow): void {
        const controls = this.rowControls.get(data.id);
        const td = controls?.enabledCell;
        if (!controls || !td) return;
        controls.tr.toggleClass("is-loaded", data.enabled);
        td.empty();
        const lamp = td.createSpan({ cls: "lazy-plugin-table-lamp", attr: { "aria-hidden": "true" } });
        lamp.toggleClass("is-loaded", data.enabled);
        lamp.toggleClass("is-memory-only", data.memoryOnly);
        td.createSpan({ text: data.status });
        td.title = data.status;
    }

    private renderModeCell(td: HTMLElement, data: PluginTableRow, controls: RowControls): void {
        const wrapper = td.createDiv({ cls: "lazy-plugin-table-mode-cell" });
        // Editing a mode is not a row click, so it never changes the selection.
        wrapper.addEventListener("click", (evt) => evt.stopPropagation());
        controls.dropdown = addModeOptions(new DropdownComponent(wrapper))
            .setValue(data.mode)
            .onChange((value) => {
                if (isPluginMode(value)) this.applyMode([data.id], value);
            });
        controls.dropdown.selectEl.setAttr("aria-label", `Mode for ${data.name}`);
        // The gear follows the dropdown, as the options belong to the mode chosen there.
        controls.gear = new ExtraButtonComponent(wrapper).setIcon("settings").onClick(() => this.openLazyOptions(data.id));
        this.syncModeControls(data);
    }

    /** The lazy options only take effect in Lazy on demand, so the gear stays in place but disabled otherwise. */
    private syncModeControls(data: PluginTableRow): void {
        const controls = this.rowControls.get(data.id);
        if (!controls?.gear || !controls.dropdown) return;
        controls.dropdown.setValue(data.mode);
        const isLazy = data.mode === PLUGIN_MODE.LAZY;
        controls.gear.setDisabled(!isLazy);
        controls.gear.setTooltip(isLazy ? "Lazy settings" : "Lazy settings apply to Lazy on demand only");
        controls.gear.extraSettingsEl.toggleClass("is-disabled", !isLazy);
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
        this.host.openLazyOptions(pluginId, () => {
            this.host.drafts.pendingPluginIds.add(pluginId);
            this.host.drafts.markDirty(this);
            this.renderPendingBar();
        });
    }

    /**
     * Stages a mode for each plugin and updates the cells in place, so a row stays
     * where it is even when it no longer matches the filter until the filters change.
     */
    private applyMode(ids: readonly string[], mode: PLUGIN_MODE): void {
        const staged = ids.filter((id) => this.host.stageMode(id, mode));
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
        const menu = new Menu();

        if (single) {
            menu.addItem((item) =>
                item
                    .setTitle("Lazy settings")
                    .setIcon("settings")
                    .setDisabled(single.mode !== PLUGIN_MODE.LAZY)
                    .onClick(() => this.openLazyOptions(single.id)),
            );
        }
        menu.addItem((item) => {
            item.setTitle(single ? "Mode" : `Mode for ${pluralizePlugins(targets.length)}`).setIcon("list-checks");
            const submenu = (item as unknown as { setSubmenu(): MenuType }).setSubmenu();
            for (const mode of MODE_ORDER) {
                submenu.addItem((subItem) =>
                    subItem
                        .setTitle(PluginModes[mode])
                        .setChecked(targets.every((row) => row.mode === mode))
                        .onClick(() => this.applyMode(
                            targets.map((row) => row.id),
                            mode,
                        )),
                );
            }
        });

        if (single) {
            menu.addSeparator();
            if (single.enabled) {
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
        return menu;
    }

    private addCopyItems(menu: MenuType, targets: readonly PluginTableRow[], single: PluginTableRow | null): void {
        const dirs = targets.flatMap((row) => (row.dir ? [row.dir] : []));
        const adapter = this.host.app.vault.adapter;
        // Only the desktop adapter has an OS path to resolve against.
        const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
        menu.addItem((item) => {
            item.setTitle("Copy").setIcon("copy");
            const submenu = (item as unknown as { setSubmenu(): MenuType }).setSubmenu();
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
            const submenu = (item as unknown as { setSubmenu(): MenuType }).setSubmenu();
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
