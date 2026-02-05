import { around } from "monkey-around";
import { ViewState, WorkspaceLeaf } from "obsidian";

interface PatchViewStateDeps {
    register: (unload: () => void) => void;
    onViewType: (viewType: string) => Promise<void>;
}

export function patchSetViewState(deps: PatchViewStateDeps): void {
    const { register, onViewType } = deps;

    // Monkey-patch `WorkspaceLeaf.setViewState` to observe when a view
    // type becomes active so we can run the `onViewType` hook.
    register(
        around(WorkspaceLeaf.prototype, {
            setViewState: (next: WorkspaceLeaf["setViewState"]) =>
                async function (this: WorkspaceLeaf, viewState: ViewState) {
                    const result = await next.call(this, viewState);
                    if (viewState?.type) {
                        await onViewType(viewState.type);
                    }
                    return result;
                },
        }),
    );
}
