import { LogLevelDesc, default as log } from "loglevel";
import { WorkspaceLeaf } from "obsidian";

export function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function toggleLoggerBy(
    level: LogLevelDesc,
    filter: (name: string) => boolean = () => true,
): void {
    Object.values(log.getLoggers())
        // @ts-expect-error - loglevel types don't expose name property
        .filter((logger) => filter(logger.name))
        .forEach((logger) => {
            logger.setLevel(level);
        });
}

export function rebuildLeafView(leaf: WorkspaceLeaf): Promise<void> {
    return (leaf as unknown as { rebuildView(): Promise<void> }).rebuildView();
}

export function isLeafVisible(leaf: WorkspaceLeaf): boolean {
    return (leaf as unknown as { isVisible(): boolean }).isVisible();
}

export function checkViewIsGone(leaf: WorkspaceLeaf): boolean {
    return (
        !!(leaf as unknown as { emptyStateEl: HTMLElement }).emptyStateEl &&
        (leaf.view as unknown as { viewType: string }).viewType !== "empty"
    );
}

export function isPluginLoaded(
    plugins: PluginsMap | undefined,
    pluginId: string,
): boolean {
    return Boolean(plugins?.[pluginId]?._loaded);
}

export type PluginsMap = Record<string, { _loaded?: boolean }>;

export function isPluginEnabled(
    enabledPlugins: Set<string>,
    pluginId: string,
): boolean {
    return enabledPlugins.has(pluginId);
}
