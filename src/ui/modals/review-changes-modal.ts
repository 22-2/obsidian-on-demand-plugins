import type { App } from "obsidian";
import { ExtraButtonComponent, Modal, setIcon } from "obsidian";
import type { PendingChange, PendingChangeGroup } from "src/ui/settings/pending-changes";

const GROUP_HEADINGS: Record<PendingChangeGroup, string> = {
    plugins: "Plugins",
    settings: "Settings",
    profiles: "Profiles",
    external: "Changed outside On-Demand (overwritten on save)",
};

export type ReviewChangesOptions = {
    /**
     * "save" offers per-item reverts before saving; "discard" only previews what will be lost;
     * "restore" offers a draft set aside when leaving On-Demand settings, with Discard as the other choice.
     */
    mode: "save" | "discard" | "restore";
    getChanges: () => PendingChange[];
    getConfirmLabel: () => string;
};

const MODE_TEXT = {
    save: { title: "Review changes", note: "Plugin mode changes are applied when saved." },
    discard: { title: "Discard changes", note: "These changes will be lost and the saved settings restored." },
    restore: { title: "Restore unsaved changes", note: "These unsaved changes were set aside when you left On-Demand settings. Restore them to keep editing, or discard them." },
};

export type RestoreChoice = { action: "restore" | "discard" | "dismiss"; dontAskAgain: boolean };
type ModalChoice = { action: "confirm" | "cancel" | "dismiss"; dontAskAgain: boolean };

/**
 * Lists the staged draft before saving or discarding it so neither action
 * touches changes the user has not seen. Resolves `true` when the user confirms.
 */
export function showReviewChangesModal(app: App, options: ReviewChangesOptions): Promise<boolean> {
    return new ReviewChangesModal(app, options).openAndWait().then((choice) => choice.action === "confirm");
}

/** Offers an unsaved draft back. Closing without a choice resolves with action "dismiss", so it can be offered again. */
export async function showRestoreDraftModal(app: App, getChanges: () => PendingChange[]): Promise<RestoreChoice> {
    const choice = await new ReviewChangesModal(app, { mode: "restore", getChanges, getConfirmLabel: () => `Restore (${getChanges().length})` }).openAndWait();
    return {
        action: choice.action === "confirm" ? "restore" : choice.action === "cancel" ? "discard" : "dismiss",
        dontAskAgain: choice.dontAskAgain,
    };
}

class ReviewChangesModal extends Modal {
    private readonly options: ReviewChangesOptions;
    private choice: ModalChoice = { action: "dismiss", dontAskAgain: false };
    private dontAskAgain?: HTMLInputElement;
    private resolve!: (choice: ModalChoice) => void;

    constructor(app: App, options: ReviewChangesOptions) {
        super(app);
        this.options = options;
    }

    onOpen() {
        this.modalEl.addClass("lazy-review-changes-modal");
        this.titleEl.setText(MODE_TEXT[this.options.mode].title);
        this.render();
    }

    onClose() {
        super.onClose();
        this.resolve(this.choice);
    }

    openAndWait(): Promise<ModalChoice> {
        const result = new Promise<ModalChoice>((resolve) => (this.resolve = resolve));
        this.open();
        return result;
    }

    private render() {
        const changes = this.options.getChanges();
        // Reverting the last item leaves nothing to save, so close instead of showing an empty list.
        if (changes.length === 0) {
            this.close();
            return;
        }
        const { contentEl } = this;
        contentEl.empty();
        // The list scrolls inside the body while the buttons stay pinned in the footer, so a long list
        // never pushes the confirm and cancel buttons off the screen.
        const body = contentEl.createDiv({ cls: "lazy-review-changes-body" });
        for (const group of Object.keys(GROUP_HEADINGS) as PendingChangeGroup[]) {
            const items = changes.filter((change) => change.group === group);
            if (items.length === 0) continue;
            // A quiet label, not a heading: a second heading-styled line would read as another dialog title.
            body.createDiv({ cls: "lazy-review-changes-group", text: `${GROUP_HEADINGS[group]} (${items.length})` });
            const list = body.createDiv({ cls: "lazy-review-changes-list" });
            items.forEach((change) => this.renderChange(list, change));
        }
        body.createEl("p", { cls: "lazy-review-changes-note", text: MODE_TEXT[this.options.mode].note });
        if (this.options.mode === "restore") {
            const rememberLabel = body.createEl("label", { cls: "lazy-restore-draft-remember" });
            this.dontAskAgain = rememberLabel.createEl("input", { attr: { type: "checkbox" } });
            rememberLabel.createSpan({ text: "Don't ask again" });
        }
        const footer = contentEl.createDiv({ cls: "lazy-review-changes-footer" });
        const buttons = footer.createDiv({ cls: "modal-button-container" });
        const confirmClass = this.options.mode === "discard" ? "mod-warning" : "mod-cta";
        buttons.createEl("button", { text: this.options.getConfirmLabel(), cls: confirmClass }).onClickEvent(() => {
            this.choice = { action: "confirm", dontAskAgain: this.options.mode === "restore" && (this.dontAskAgain?.checked ?? false) };
            this.close();
        });
        // Restoring is a choice between two actions, so the second button names the other one.
        buttons.createEl("button", { text: this.options.mode === "restore" ? "Discard" : "Cancel" }).onClickEvent(() => {
            this.choice = { action: "cancel", dontAskAgain: this.options.mode === "restore" && (this.dontAskAgain?.checked ?? false) };
            this.close();
        });
    }

    private renderChange(list: HTMLElement, change: PendingChange) {
        // A plain row rather than a Setting: mobile Setting styles stack the revert button below long text.
        const item = list.createDiv({ cls: "lazy-review-changes-item" });
        const info = item.createDiv({ cls: "lazy-review-changes-info" });
        info.createDiv({ cls: "lazy-review-changes-name", text: change.label });
        const desc = info.createDiv({ cls: "lazy-review-changes-desc" });
        if (this.options.mode === "discard") {
            // Discarding drops the draft value (`to`) and restores the saved one (`from`). Say so in words,
            // since an arrow would read as a change being made.
            desc.createSpan({ cls: "lazy-review-changes-lost", text: change.to });
            if (change.from !== undefined) {
                desc.createSpan({ cls: "lazy-review-changes-restore-label", text: " · restores " });
                desc.createSpan({ cls: "lazy-review-changes-to", text: change.from });
            }
            // Discarding drops every change at once, so single reverts would only add noise there.
            return;
        }
        if (change.from !== undefined) {
            desc.createSpan({ cls: "lazy-review-changes-from", text: change.from });
            // An icon rather than a "→" glyph: the glyph is too thin to read at this size, even when bolded.
            setIcon(desc.createSpan({ cls: "lazy-review-changes-arrow" }), "arrow-right");
        }
        desc.createSpan({ cls: "lazy-review-changes-to", text: change.to });
        const revert = change.revert;
        // A restore is all or nothing; edits continue in the settings once it is back.
        if (!revert || this.options.mode === "restore") return;
        new ExtraButtonComponent(item)
            .setIcon("rotate-ccw")
            .setTooltip("Revert this change")
            .onClick(() => {
                revert();
                this.render();
            });
    }
}
