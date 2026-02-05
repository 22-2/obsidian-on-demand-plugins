import { App, TFile, WorkspaceLeaf, EventRef } from "obsidian";

interface ExcalidrawWrapperDeps {
    app: App;
    registerEvent: (ref: EventRef) => void;
    getPluginMode: (pluginId: string) => string;
    ensurePluginLoaded: (pluginId: string) => Promise<boolean>;
}

const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

function isExcalidrawFile(app: App, file: TFile | null | undefined): boolean {
    if (!file) return false;
    try {
        if (file.extension === "excalidraw") return true;
        // also treat files with frontmatter key `excalidraw-plugin` as Excalidraw
        const cache = app.metadataCache.getFileCache(file as any);
        return !!cache?.frontmatter && Object.prototype.hasOwnProperty.call(cache.frontmatter, "excalidraw-plugin");
    } catch (e) {
        return false;
    }
}

export function registerExcalidrawWrapper(deps: ExcalidrawWrapperDeps) {
    const { app, registerEvent, getPluginMode, ensurePluginLoaded } = deps;

    // Handle file-open: when a file that is an Excalidraw drawing is opened, ensure plugin is loaded first
    registerEvent(
        app.workspace.on("file-open", async (file: TFile | null) => {
            if (!file) return;
            if (!isExcalidrawFile(app, file)) return;
            const mode = getPluginMode(EXCALIDRAW_PLUGIN_ID);
            if (mode !== "lazyOnView") return;

            await ensurePluginLoaded(EXCALIDRAW_PLUGIN_ID);
            // After plugin loaded, attempt to open the file in the proper view (plugin will register view types)
            try {
                const leaf = app.workspace.getLeaf(false) as WorkspaceLeaf;
                if (leaf && file) {
                    // openFile will let the freshly-loaded plugin take over and set its view
                    await leaf.openFile(file);
                }
            } catch (e) {
                // swallow errors; best-effort
            }
        }),
    );

    // Handle layout restore: iterate leaves and load plugin for any excalidraw files that are present
    // app.workspace.onLayoutReady may not return an EventRef in some typings, so don't pass it to registerEvent
    app.workspace.onLayoutReady(() => {
        if (!app.workspace.layoutReady) return;
        app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
            try {
                const state: any = (leaf.view as any)?.getState?.() ?? {};
                const path = state?.file ?? null;
                if (!path) return;
                const f = app.vault.getAbstractFileByPath(path) as TFile | null;
                if (!f) return;
                if (!isExcalidrawFile(app, f)) return;
                const mode = getPluginMode(EXCALIDRAW_PLUGIN_ID);
                if (mode !== "lazyOnView") return;
                // ensure plugin loaded, then try to re-open file in this leaf
                void ensurePluginLoaded(EXCALIDRAW_PLUGIN_ID).then(async (loaded) => {
                    if (!loaded) return;
                    try {
                        await leaf.openFile(f);
                    } catch (e) {
                        // ignore
                    }
                });
            } catch (e) {
                // ignore per-leaf errors
            }
        });
    });
}
