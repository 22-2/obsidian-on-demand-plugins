import { LogLevelDesc, default as log } from "loglevel";
import { App, WorkspaceLeaf } from "obsidian";
import { PluginMode } from "src/settings";

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

export function isPluginLoaded(
    app: App,
    pluginId: string,
    strict = false
): boolean {
    const plugins = app.plugins;
    if (!plugins) return false;
    
    const isEnabled = plugins.enabledPlugins?.has(pluginId);
    const isLoaded = Boolean(plugins.plugins?.[pluginId]?._loaded);

    if (strict) {
        return Boolean(isEnabled && isLoaded);
    } else {
        return Boolean(isLoaded);
    }
}

export function isPluginEnabled(
    enabledPlugins: Set<string>,
    pluginId: string,
): boolean {
    return enabledPlugins.has(pluginId);
}

/**
 * Checks if a plugin mode is lazy (any mode that is not "keepEnabled" or "disabled")
 */
export function isLazyMode(mode: PluginMode): boolean {
    return mode === "lazy" || mode === "lazyOnView" || mode === "lazyOnLayoutReady";
}

