import log from "loglevel";
import { around } from "monkey-around";
import type { ViewState } from "obsidian";
import { WorkspaceLeaf } from "obsidian";

const logger = log.getLogger("OnDemandPlugin/ViewStatePatch");

interface PatchViewStateDeps {
    register: (unload: () => void) => void;
    onViewType: (viewType: string) => Promise<void>;
}

// ── Patch ────────────────────────────────────────────────────────────────────

/**
 * Monkey-patch `WorkspaceLeaf.setViewState` to observe when a view
 * type becomes active so we can run the `onViewType` hook.
 */
export function patchSetViewState(deps: PatchViewStateDeps): void {
    const { register, onViewType } = deps;
    register(
        around(WorkspaceLeaf.prototype, {
            setViewState: (next: WorkspaceLeaf["setViewState"]) =>
                async function (this: WorkspaceLeaf, viewState: ViewState, eState?: unknown): Promise<void> {
                    const result = await next.call(this, viewState, eState);
                    if (viewState?.type) {
                        // Patch hook failures should not block Obsidian's view transition.
                        try {
                            await onViewType(viewState.type);
                        } catch (error) {
                            // Intentionally log every failure so repeated instability remains visible.
                            logger.warn("setViewState hook failed:", error);
                        }
                    }
                    return result;
                },
        }),
    );
}
