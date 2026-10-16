import type { SortingState } from "@tanstack/table-core";

export const PLUGIN_TABLE_COLUMN_IDS = ["name", "id", "author", "enabled", "mode", "description", "actions"] as const;
export type PluginTableColumnId = (typeof PLUGIN_TABLE_COLUMN_IDS)[number];

/** Filters are intentionally excluded so each view opens with an unfiltered list. */
export interface PluginTableState {
    sorting: SortingState;
    columnVisibility: Record<string, boolean>;
    columnWidths: Record<string, number>;
}

export const MIN_COLUMN_WIDTH = 60;

/** Phones hide the long text columns at first so the name and mode fit without scrolling sideways. */
export function defaultTableState(isPhone: boolean): PluginTableState {
    const columnVisibility: Record<string, boolean> = { id: false };
    if (isPhone) {
        columnVisibility.author = false;
        columnVisibility.description = false;
    }
    return { sorting: [{ id: "enabled", desc: true }], columnVisibility, columnWidths: {} };
}

function isColumnId(id: unknown): id is PluginTableColumnId {
    return (PLUGIN_TABLE_COLUMN_IDS as readonly unknown[]).includes(id);
}

function isColumnSort(value: unknown): value is SortingState[number] {
    if (typeof value !== "object" || value === null) return false;
    const sort = value as Record<string, unknown>;
    return isColumnId(sort.id) && typeof sort.desc === "boolean";
}

/**
 * Fill missing slices with defaults and drop entries that reference unknown
 * columns, since the state comes from local storage written by other versions.
 */
export function sanitizeTableState(input: unknown, defaults: PluginTableState): PluginTableState {
    const parsed = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof PluginTableState, unknown>>;
    const sorting = Array.isArray(parsed.sorting)
        ? (parsed.sorting as unknown[]).filter(isColumnSort)
        : structuredClone(defaults.sorting);
    const columnVisibility: Record<string, boolean> = { ...defaults.columnVisibility };
    if (typeof parsed.columnVisibility === "object" && parsed.columnVisibility !== null) {
        for (const [key, value] of Object.entries(parsed.columnVisibility)) {
            if (isColumnId(key) && typeof value === "boolean") columnVisibility[key] = value;
        }
    }
    // The name column is always visible, and the actions column follows the platform rather than the user.
    delete columnVisibility.name;
    delete columnVisibility.actions;
    const columnWidths: Record<string, number> = {};
    if (typeof parsed.columnWidths === "object" && parsed.columnWidths !== null) {
        for (const [key, value] of Object.entries(parsed.columnWidths)) {
            if (isColumnId(key) && typeof value === "number" && value >= MIN_COLUMN_WIDTH) columnWidths[key] = value;
        }
    }
    return { sorting, columnVisibility, columnWidths };
}
