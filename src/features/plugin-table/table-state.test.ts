import { defaultTableState, sanitizeTableState } from "src/features/plugin-table/table-state";
import { describe, expect, it } from "vitest";

describe("plugin table state", () => {
    it("hides the long text columns on phones only", () => {
        expect(defaultTableState(true).columnVisibility).toEqual({ id: false, author: false, description: false });
        expect(defaultTableState(false).columnVisibility).toEqual({ id: false });
    });

    it("falls back to the defaults for unreadable storage", () => {
        const defaults = defaultTableState(false);
        expect(sanitizeTableState(null, defaults)).toEqual(defaults);
        expect(sanitizeTableState("broken", defaults)).toEqual(defaults);
    });

    it("drops unknown columns, too-narrow widths and the columns the user cannot hide", () => {
        const state = sanitizeTableState(
            {
                sorting: [{ id: "mode", desc: false }, { id: "removed", desc: true }, { id: "name" }],
                columnVisibility: { author: false, name: false, actions: true, removed: true },
                columnWidths: { mode: 300, author: 10, removed: 200 },
            },
            defaultTableState(false),
        );

        expect(state.sorting).toEqual([{ id: "mode", desc: false }]);
        expect(state.columnVisibility).toEqual({ id: false, author: false });
        expect(state.columnWidths).toEqual({ mode: 300 });
    });
});
