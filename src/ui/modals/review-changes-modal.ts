import type { App } from "obsidian";
import { ExtraButtonComponent, Modal, Setting, setIcon } from "obsidian";
import type { PendingChange, PendingChangeGroup } from "src/ui/settings/pending-changes";

const GROUP_HEADINGS: Record<PendingChangeGroup, string> = {
    plugins: "Plugins",
    settings: "Settings",
    profiles: "Profiles",
};

export type ReviewChangesOptions = {
    /** "save" offers per-item reverts before saving; "discard" only previews what will be lost. */
    mode: "save" | "discard";
    getChanges: () => PendingChange[];
    getConfirmLabel: () => string;
};

const MODE_TEXT = {
    save: { title: "Review changes", note: "Plugin mode changes are applied when saved." },
    discard: { title: "Discard changes", note: "These changes will be lost and the saved settings restored." },
};

/**
 * Lists the staged draft before saving or discarding it so neither action
 * touches changes the user has not seen. Resolves `true` when the user confirms.
 */
export function showReviewChangesModal(app: App, options: ReviewChangesOptions): Promise<boolean> {
    return new ReviewChangesModal(app, options).openAndWait();
}

class ReviewChangesModal extends Modal {
    private readonly options: ReviewChangesOptions;
    private confirmed = false;
    private resolve!: (confirmed: boolean) => void;

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
        this.resolve(this.confirmed);
    }

    openAndWait(): Promise<boolean> {
        const result = new Promise<boolean>((resolve) => (this.resolve = resolve));
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
            new Setting(body).setName(`${GROUP_HEADINGS[group]} (${items.length})`).setHeading();
            const list = body.createDiv({ cls: "lazy-review-changes-list" });
            items.forEach((change) => this.renderChange(list, change));
        }
        body.createEl("p", { cls: "lazy-review-changes-note", text: MODE_TEXT[this.options.mode].note });
        const footer = contentEl.createDiv({ cls: "lazy-review-changes-footer" });
        const buttons = footer.createDiv({ cls: "modal-button-container" });
        const confirmClass = this.options.mode === "discard" ? "mod-warning" : "mod-cta";
        buttons.createEl("button", { text: this.options.getConfirmLabel(), cls: confirmClass }).onClickEvent(() => {
            this.confirmed = true;
            this.close();
        });
        buttons.createEl("button", { text: "Cancel" }).onClickEvent(() => this.close());
    }

    private renderChange(list: HTMLElement, change: PendingChange) {
        // A plain row rather than a Setting: mobile Setting styles stack the revert button below long text.
        const item = list.createDiv({ cls: "lazy-review-changes-item" });
        const info = item.createDiv({ cls: "lazy-review-changes-info" });
        info.createDiv({ cls: "lazy-review-changes-name", text: change.label });
        const desc = info.createDiv({ cls: "lazy-review-changes-desc" });
        if (change.from !== undefined) {
            desc.createSpan({ cls: "lazy-review-changes-from", text: change.from });
            // An icon rather than a "→" glyph: the glyph is too thin to read at this size, even when bolded.
            setIcon(desc.createSpan({ cls: "lazy-review-changes-arrow" }), "arrow-right");
        }
        desc.createSpan({ cls: "lazy-review-changes-to", text: change.to });
        const revert = change.revert;
        // Discarding drops every change at once, so single reverts would only add noise there.
        if (!revert || this.options.mode === "discard") return;
        new ExtraButtonComponent(item)
            .setIcon("rotate-ccw")
            .setTooltip("Revert this change")
            .onClick(() => {
                revert();
                this.render();
            });
    }
}
