import log from "loglevel";
import { TFile, View, WorkspaceLeaf } from "obsidian";
import { PluginLoader } from "../../core/interfaces";
import { PluginContext } from "../../core/plugin-context";
import { resolvePluginForFile } from "./helpers/activation-rules";
import { LockStrategy } from "./helpers/leaf-lock";
import { BaseLazyLoader } from "./base-lazy-loader";

const logger = log.getLogger("OnDemandPlugin/FileLazyLoader");

/**
 * Type guard to check if a view has a file property
 */
interface ViewWithFile extends View {
    file?: TFile;
}

/**
 * Interface for view state that may contain a file path
 */
interface ViewState {
    file?: string;
    [key: string]: any;
}

/**
 * Handles lazy loading of plugins based on file criteria.
 * When a file is opened that matches certain criteria (suffix, frontmatter, content),
 * the corresponding plugin is loaded and the view is rebuilt.
 */
export class FileLazyLoader extends BaseLazyLoader<WorkspaceLeaf> {
    constructor(
        ctx: PluginContext,
        pluginLoader: PluginLoader & { ensurePluginLoaded(pluginId: string): Promise<boolean> },
        lockStrategy: LockStrategy<WorkspaceLeaf>,
    ) {
        super(ctx, pluginLoader, lockStrategy);
    }

    register(): void {
        const { app } = this.ctx;

        this.ctx.registerEvent(
            app.workspace.on("file-open", async (file: TFile | null) => {
                if (!file) return;

                app.workspace.iterateAllLeaves((leaf) => {
                    const viewFile = (leaf.view as ViewWithFile).file;
                    if (viewFile === file) {
                        void this.checkFileForLazyLoading(file, leaf);
                    }
                });
            }),
        );

        // Initial layout scan
        app.workspace.onLayoutReady(() => {
            app.workspace.iterateAllLeaves((leaf) => {
                const file = this.getFileFromLeaf(leaf);
                if (file) {
                    void this.checkFileForLazyLoading(file, leaf);
                }
            });
        });
    }

    /**
     * Safely extracts the file from a leaf's view state
     */
    private getFileFromLeaf(leaf: WorkspaceLeaf): TFile | null {
        try {
            const view = leaf.view as ViewWithFile;
            const state = (view.getState?.() as ViewState) ?? {};
            const path = state.file ?? null;
            if (!path) return null;

            const file = this.ctx.app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? file : null;
        } catch (e) {
            logger.debug("FileLazyLoader: error extracting file from leaf", e);
            return null;
        }
    }

    private async checkFileForLazyLoading(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
        const leafId = this.getLeafId(leaf);

        await this.loadPluginWithLock(
            leaf,
            async () => resolvePluginForFile(this.ctx, file),
            { leafId, description: file.path },
            async (wasNewlyLoaded) => {
                // Only rebuild if the plugin was newly loaded
                if (!wasNewlyLoaded) {
                    logger.debug(`skipping rebuildLeafView for ${file.path} - plugin was not newly loaded`);
                    return;
                }

                // Check if the view has already been transformed by the plugin
                const viewTypeAfterLoad = leaf.view.getViewType();
                if (viewTypeAfterLoad !== "markdown") {
                    logger.debug(
                        `skipping rebuildLeafView for ${file.path} - view already transformed to ${viewTypeAfterLoad}`,
                    );
                    return;
                }

                // After loading the plugin, rebuild the view if still needed
                await this.rebuildLeafViewWithLogging(leaf, leafId);
            },
        );
    }
}
