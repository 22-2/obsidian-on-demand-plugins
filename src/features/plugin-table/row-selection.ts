export interface SelectionModifiers {
    toggle: boolean;
    range: boolean;
}

/**
 * Explorer-style row selection, independent from DOM event handling.
 * Rows are keyed by plugin ID so the selection survives sorting and re-renders;
 * ranges are resolved against the row order currently on screen.
 */
export class RowSelection {
    private selectedIds = new Set<string>();
    private anchorId: string | null = null;

    select(id: string, visibleIds: readonly string[], modifiers: SelectionModifiers): void {
        const anchorIndex = this.anchorId === null ? -1 : visibleIds.indexOf(this.anchorId);
        const index = visibleIds.indexOf(id);
        if (index < 0) return;
        if (modifiers.range && anchorIndex >= 0) {
            const range = visibleIds.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1);
            this.selectedIds = modifiers.toggle ? new Set([...this.selectedIds, ...range]) : new Set(range);
            return;
        }
        if (modifiers.toggle) {
            if (!this.selectedIds.delete(id)) this.selectedIds.add(id);
            this.anchorId = id;
            return;
        }
        this.selectedIds = new Set([id]);
        this.anchorId = id;
    }

    selectForContextMenu(id: string): void {
        if (this.selectedIds.has(id)) return;
        // Explorer keeps a multi-selection when it is right-clicked, but
        // right-clicking outside it starts a new one-item selection.
        this.selectedIds = new Set([id]);
        this.anchorId = id;
    }

    /** Drop rows that left the screen so batch actions never touch plugins the user cannot see. */
    retain(visibleIds: readonly string[]): void {
        const visible = new Set(visibleIds);
        this.selectedIds = new Set([...this.selectedIds].filter((id) => visible.has(id)));
        if (this.anchorId !== null && !visible.has(this.anchorId)) this.anchorId = null;
    }

    has(id: string): boolean {
        return this.selectedIds.has(id);
    }

    /** Selected IDs in on-screen order. */
    ids(visibleIds: readonly string[]): string[] {
        return visibleIds.filter((id) => this.selectedIds.has(id));
    }
}
