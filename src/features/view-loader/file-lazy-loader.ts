import { TFile, WorkspaceLeaf } from "obsidian";
import { PluginContext } from "../../core/plugin-context";
import { PluginLoader } from "../../core/interfaces";
import { rebuildLeafView } from "../../utils/utils";
import log from "loglevel";

const logger = log.getLogger("OnDemandPlugin/FileLazyLoader");

export class FileLazyLoader {
    constructor(
        private ctx: PluginContext,
        private pluginLoader: PluginLoader & { ensurePluginLoaded(pluginId: string): Promise<boolean> },
    ) {}

    register(): void {
        const { app } = this.ctx;

        this.ctx.registerEvent(
            app.workspace.on("file-open", async (file: TFile | null) => {
                if (!file) return;
                const leaf = app.workspace.getLeaf(false);
                if (leaf) {
                    await this.checkFileForLazyLoading(file, leaf);
                }
            }),
        );

        // Initial layout scan
        app.workspace.onLayoutReady(() => {
            app.workspace.iterateAllLeaves((leaf) => {
                try {
                    const state: any = (leaf.view as any)?.getState?.() ?? {};
                    const path = state?.file ?? null;
                    if (!path) return;
                    const f = app.vault.getAbstractFileByPath(path);
                    if (f instanceof TFile) {
                        void this.checkFileForLazyLoading(f, leaf);
                    }
                } catch (e) {
                    logger.debug("FileLazyLoader: error during layout scan", e);
                }
            });
        });
    }

    async checkFileForLazyLoading(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
        const settings = this.ctx.getSettings();
        const lazyOnFiles = settings.lazyOnFiles || {};

        // Merge defaults if necessary (e.g. Excalidraw)
        const allRules = { ...this.getDefaultRules(), ...lazyOnFiles };

        for (const [pluginId, criteria] of Object.entries(allRules)) {
            const mode = this.ctx.getPluginMode(pluginId);
            if (mode !== "lazyOnView") continue;

            if (await this.matchesCriteria(file, criteria)) {
                const loaded = await this.pluginLoader.ensurePluginLoaded(pluginId);
                if (loaded && leaf) {
                    try {
                        // After plugin load, we typically need to rebuild the view
                        // so the plugin can take over the leaf with its specialized view.
                        await rebuildLeafView(leaf);
                    } catch (e) {
                        logger.debug(`FileLazyLoader: error rebuilding view for plugin ${pluginId}`, e);
                    }
                }
                break; // Stop at first matching plugin
            }
        }
    }

    private getDefaultRules(): Record<string, import("../../core/types").FileActivationCriteria> {
        return {
            "obsidian-excalidraw-plugin": {
                extensions: ["excalidraw"],
                frontmatterKeys: ["excalidraw-plugin"],
            },
        };
    }

    private async matchesCriteria(file: TFile, criteria: import("../../core/types").FileActivationCriteria): Promise<boolean> {
        const { app } = this.ctx;

        // 1. Extension check
        if (criteria.extensions?.includes(file.extension)) {
            return true;
        }

        // 2. Frontmatter check
        if (criteria.frontmatterKeys?.length) {
            const cache = app.metadataCache.getFileCache(file);
            if (cache?.frontmatter) {
                for (const key of criteria.frontmatterKeys) {
                    if (Object.prototype.hasOwnProperty.call(cache.frontmatter, key)) {
                        return true;
                    }
                }
            }
        }

        // 3. Content Pattern check (Regex)
        if (criteria.contentPatterns?.length) {
            try {
                const content = await app.vault.cachedRead(file);
                for (const pattern of criteria.contentPatterns) {
                    const regex = new RegExp(pattern);
                    if (regex.test(content)) {
                        return true;
                    }
                }
            } catch (e) {
                logger.debug(`FileLazyLoader: error reading file content for pattern match: ${file.path}`, e);
            }
        }

        return false;
    }
}
