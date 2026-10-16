import { RowSelection } from "src/features/plugin-table/row-selection";
import { describe, expect, it } from "vitest";

const visible = ["a", "b", "c", "d"];
const plain = { toggle: false, range: false };

describe("plugin table row selection", () => {
    it("selects a range from the anchor in on-screen order", () => {
        const selection = new RowSelection();
        selection.select("b", visible, plain);
        selection.select("d", visible, { toggle: false, range: true });

        expect(selection.ids(visible)).toEqual(["b", "c", "d"]);
    });

    it("keeps a multi-selection when one of its rows is right-clicked", () => {
        const selection = new RowSelection();
        selection.select("a", visible, plain);
        selection.select("c", visible, { toggle: true, range: false });

        selection.selectForContextMenu("c");
        expect(selection.ids(visible)).toEqual(["a", "c"]);

        selection.selectForContextMenu("d");
        expect(selection.ids(visible)).toEqual(["d"]);
    });

    it("drops rows that a filter hid", () => {
        const selection = new RowSelection();
        selection.select("a", visible, plain);
        selection.select("b", visible, { toggle: true, range: false });

        selection.retain(["b", "c"]);

        expect(selection.ids(visible)).toEqual(["b"]);
    });

    it("ignores rows that are not on screen", () => {
        const selection = new RowSelection();
        selection.select("z", visible, plain);
        expect(selection.ids(visible)).toEqual([]);
    });

    it("adds a range to the selection with the toggle modifier", () => {
        const selection = new RowSelection();
        selection.select("a", visible, plain);
        selection.select("c", visible, { toggle: true, range: false });
        selection.select("d", visible, { toggle: true, range: true });
        expect(selection.ids(visible)).toEqual(["a", "c", "d"]);
    });

    it("forgets the anchor once its row is hidden", () => {
        const selection = new RowSelection();
        selection.retain(visible);
        selection.select("b", visible, plain);
        selection.retain(["c"]);
        // Without an anchor, a range click selects just the clicked row.
        selection.select("d", visible, { toggle: false, range: true });
        expect(selection.ids(visible)).toEqual(["d"]);
    });
});
