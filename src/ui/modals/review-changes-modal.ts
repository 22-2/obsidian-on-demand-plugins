import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type { PendingChange, PendingChangeGroup } from "src/ui/settings/pending-changes";

const GROUP_HEADINGS: Record<PendingChangeGroup, string> = {
    plugins: "Plugins",
    settings: "Settings",
    profiles: "Profiles",
};

export type ReviewChangesOptions = {
    getChanges: () => PendingChange[];
    /** Label for the confirm button, kept identical to the bar's save button. */
    getSaveLabel: () => string;
};

/**
 * Lists the staged draft before saving so a save never applies changes the
 * user has not seen. Resolves `true` when the user confirms the save.
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
        this.titleEl.setText("Review changes");
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
        for (const group of Object.keys(GROUP_HEADINGS) as PendingChangeGroup[]) {
            const items = changes.filter((change) => change.group === group);
            if (items.length === 0) continue;
            new Setting(contentEl).setName(`${GROUP_HEADINGS[group]} (${items.length})`).setHeading();
            const list = contentEl.createDiv({ cls: "lazy-review-changes-list" });
            items.forEach((change) => this.renderChange(list, change));
        }
        contentEl.createEl("p", { cls: "lazy-review-changes-note", text: "Plugin mode changes are applied when saved." });
        const buttons = contentEl.createDiv({ cls: "modal-button-container" });
        buttons.createEl("button", { text: this.options.getSaveLabel(), cls: "mod-cta" }).onClickEvent(() => {
            this.confirmed = true;
            this.close();
        });
        buttons.createEl("button", { text: "Cancel" }).onClickEvent(() => this.close());
    }

    private renderChange(list: HTMLElement, change: PendingChange) {
        const setting = new Setting(list).setName(change.label).setDesc(
            createFragment((fragment) => {
                if (change.from !== undefined) {
                    fragment.createSpan({ cls: "lazy-review-changes-from", text: change.from });
                    fragment.createSpan({ cls: "lazy-review-changes-arrow", text: " → " });
                }
                fragment.createSpan({ cls: "lazy-review-changes-to", text: change.to });
            }),
        );
        const revert = change.revert;
        if (!revert) return;
        setting.addExtraButton((button) =>
            button
                .setIcon("rotate-ccw")
                .setTooltip("Revert this change")
                .onClick(() => {
                    revert();
                    this.render();
                }),
        );
    }
}
