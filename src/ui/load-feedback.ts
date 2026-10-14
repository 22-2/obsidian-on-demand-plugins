import type { WorkspaceLeaf } from "obsidian";
import { Notice } from "obsidian";
import type { PluginContext } from "src/core/plugin-context";

const RESULT_NOTICE_MS = 2_000;
const FAILURE_NOTICE_MS = 5_000;
const LOADING_CLASS = "lazy-plugin-view-loading";
const LOADING_HOST_CLASS = "lazy-plugin-view-loading-host";

export function getPluginDisplayName(ctx: PluginContext, pluginId: string): string {
    return ctx.obsidianPlugins?.manifests?.[pluginId]?.name ?? pluginId;
}

/**
 * A notice that stays up while a lazy plugin loads, then reports the result in place.
 * Reusing one notice keeps the "loading" and "loaded" messages from stacking.
 */
export class PluginLoadNotice {
    private notice: Notice;
    private name: string;

    constructor(name: string) {
        this.name = name;
        // Duration 0 keeps the notice until the load settles.
        this.notice = new Notice(`Loading ${name}…`, 0);
    }

    succeed(): void {
        this.settle(`${this.name} loaded`, RESULT_NOTICE_MS);
    }

    fail(): void {
        this.settle(`Failed to load ${this.name}`, FAILURE_NOTICE_MS);
    }

    private settle(message: string, hideAfterMs: number): void {
        this.notice.setMessage(message);
        window.setTimeout(() => this.notice.hide(), hideAfterMs);
    }
}

/**
 * Overlay a spinner on a leaf whose view belongs to a plugin that is still loading.
 * Obsidian shows an empty placeholder until the plugin registers its view type and the
 * leaf is rebuilt; the rebuild replaces the view's container, which drops the overlay.
 * @returns A function that removes the overlay if the container is still in place.
 */
export function showLeafLoading(leaf: WorkspaceLeaf, name: string): () => void {
    const containerEl = (leaf.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
    if (!containerEl || typeof containerEl.createDiv !== "function") return () => {};
    // Several triggers (active-leaf-change, resize, setViewState) can race for the same leaf.
    if (containerEl.querySelector(`:scope > .${LOADING_CLASS}`)) return () => {};

    containerEl.addClass(LOADING_HOST_CLASS);
    const overlayEl = containerEl.createDiv({ cls: LOADING_CLASS });
    overlayEl.createDiv({ cls: "lazy-plugin-spinner" });
    overlayEl.createDiv({ cls: "lazy-plugin-view-loading-text", text: `Loading ${name}…` });

    return () => {
        overlayEl.remove();
        containerEl.removeClass(LOADING_HOST_CLASS);
    };
}
