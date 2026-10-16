import type { WorkspaceLeaf } from "obsidian";
import { ItemView } from "obsidian";
import { PLUGIN_LOAD_STATE_CHANGED_EVENT } from "src/core/constants";
import { loadLocalStorage, saveLocalStorage } from "src/core/storage";
import { PluginTable } from "src/features/plugin-table/plugin-table";
import type { PluginTableHost } from "src/features/plugin-table/plugin-table-host";
import { defaultTableState, sanitizeTableState } from "src/features/plugin-table/table-state";

export const VIEW_TYPE_PLUGIN_TABLE = "on-demand-plugin-table";
const TABLE_STATE_STORAGE_KEY = "plugin-table-state";

/**
 * Workspace view for editing loading modes in a table. It is a surface of the shared
 * draft, so closing it sets an unsaved draft aside exactly like closing settings.
 */
export class PluginTableView extends ItemView {
    private readonly host: PluginTableHost;
    private table?: PluginTable;
    private unsubscribeDrafts?: () => void;

    constructor(leaf: WorkspaceLeaf, host: PluginTableHost) {
        super(leaf);
        this.host = host;
    }

    getViewType() {
        return VIEW_TYPE_PLUGIN_TABLE;
    }

    getDisplayText() {
        return "Plugin table";
    }

    getIcon() {
        return "table";
    }

    async onOpen() {
        const drafts = this.host.drafts;
        drafts.openSurface("plugin-table");

        this.addAction("refresh-cw", "Refresh plugin list", () => this.table?.refresh());

        const defaults = defaultTableState(this.contentEl.doc.body.hasClass("is-phone"));
        this.contentEl.empty();
        this.contentEl.addClass("lazy-plugin-table-view");
        this.table = new PluginTable(this.contentEl, this.host, {
            // Kept in vault-scoped local storage, not in the staged settings draft, so it saves at once.
            initialState: sanitizeTableState(loadLocalStorage(this.app, TABLE_STATE_STORAGE_KEY), defaults),
            onStateChange: (state) => saveLocalStorage(this.app, TABLE_STATE_STORAGE_KEY, state),
        });

        // A save, discard or restore replaces the draft, and the settings list edits it in place;
        // either way the rows are re-read. The table's own edits already updated its cells.
        this.unsubscribeDrafts = drafts.onChange((_kind, source) => {
            if (source !== this.table) this.table?.refresh();
        });
        // @ts-expect-error - Custom workspace event
        this.registerEvent(this.app.workspace.on(PLUGIN_LOAD_STATE_CHANGED_EVENT, () => this.table?.refreshLoadState()));
        // Obsidian fires this after update checks, installs and enable-state changes made from its own settings.
        this.registerEvent(this.app.plugins.on("changed", () => this.table?.refresh()));

        // Not awaited: the view opens behind the prompt instead of waiting for the answer.
        drafts.offerRestoreOnPageOpen("plugin-table");
    }

    async onClose() {
        this.unsubscribeDrafts?.();
        this.unsubscribeDrafts = undefined;
        this.table?.destroy();
        this.table = undefined;
        const drafts = this.host.drafts;
        drafts.requestRestoreOnPageClose("plugin-table");
        drafts.closeSurface("plugin-table");
    }
}
