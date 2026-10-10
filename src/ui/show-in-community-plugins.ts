import type { App } from "obsidian";

const pendingReveals = new WeakMap<App, () => void>();

export function showInCommunityPlugins(app: App, pluginId: string): void {
    // Cancel an earlier navigation so a delayed popout layout cannot reveal the wrong plugin.
    pendingReveals.get(app)?.();
    app.setting.open();
    app.setting.openTabById("community-plugins");

    const container = app.setting.tabContentContainer;
    const searchInput = container.querySelector<HTMLInputElement>(".vertical-tab-content input[type='search']");
    if (searchInput?.value) {
        searchInput.value = "";
        // Settings may be in a popout, so dispatch the input event in that document's realm.
        const view = searchInput.ownerDocument.defaultView;
        if (view) searchInput.dispatchEvent(new view.Event("input", { bubbles: true }));
    }

    // The built-in installed list exposes IDs on rows but has no public navigation API.
    const row = Array.from(container.querySelectorAll<HTMLElement>(".vertical-tab-content [data-plugin-id]")).find((element) => element.dataset.pluginId === pluginId);
    const view = container.ownerDocument.defaultView;
    if (!row || !view) return;

    let frameId: number;
    let previousBounds: DOMRect | undefined;
    let stableSince: number | undefined;
    const startedAt = view.performance.now();
    const cancel = () => {
        view.cancelAnimationFrame(frameId);
        pendingReveals.delete(app);
    };
    const checkLayout = (now: number) => {
        if (!row.isConnected || app.setting.activeTab?.id !== "community-plugins" || now - startedAt >= 2000) {
            cancel();
            return;
        }

        // A settings popout can resize several times before settling; scroll after stable geometry.
        const bounds = container.getBoundingClientRect();
        const hasSize = bounds.width > 0 && bounds.height > 0;
        const unchanged = hasSize && bounds.width === previousBounds?.width && bounds.height === previousBounds?.height && bounds.top === previousBounds?.top && bounds.left === previousBounds?.left;
        if (!unchanged) stableSince = hasSize ? now : undefined;
        previousBounds = bounds;
        if (stableSince !== undefined && now - stableSince >= 100) {
            cancel();
            row.scrollIntoView(true);
            // Use a short background animation to identify the destination without changing the core row.
            row.animate([{ backgroundColor: "var(--background-modifier-hover)" }, { backgroundColor: "transparent" }], { duration: 1600 });
            return;
        }
        frameId = view.requestAnimationFrame(checkLayout);
    };
    frameId = view.requestAnimationFrame(checkLayout);
    pendingReveals.set(app, cancel);
}
