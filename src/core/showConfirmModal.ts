import type { App } from "obsidian";
import { Modal } from "obsidian";

/**
 * Show a confirmation modal and return the user's choice.
 *
 * - Returns `true` when the user selects "Yes"
 * - Returns `false` when the user selects "Cancel"
 * - Returns `null` when the modal was closed without an explicit choice
 *
 * Example:
 * ```ts
 * const result = await showConfirmModal(app, { message: "Proceed with this action?" });
 * if (result === true) {
 *   // User confirmed
 * }
 * ```
 */
export async function showConfirmModal(app: App, args: { message: string }): Promise<boolean | null> {
    return new ConfirmModal(app, args.message).open();
}

export class ConfirmModal extends Modal {
    submitted = false;
    // Resolver for the returned Promise
    resolve!: (value: boolean | null) => void;

    constructor(
        app: App,
        public message: string,
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText("Confirm");

        // Message
        this.contentEl.createEl("p", { text: this.message });

        // Button container
        const buttonContainer = this.contentEl.createDiv("modal-button-container");

        // --- Yes / OK button ---
        const confirmButton = buttonContainer.createEl("button", {
            text: "Yes",
            cls: "mod-cta",
        });

        const handleConfirm = () => {
            this.resolve(true);
            this.submitted = true;
            this.close();
        };

        confirmButton.onClickEvent(handleConfirm);

        // Make Enter key trigger "Yes"
        this.scope.register(null, "Enter", handleConfirm);

        // --- Cancel button ---
        const cancelButton = buttonContainer.createEl("button", {
            text: "Cancel",
        });
        cancelButton.onClickEvent(() => {
            this.resolve(false);
            this.submitted = true;
            this.close();
        });
    }

    /**
     * Called when the modal is closed. If no explicit choice was made
     * (submitted is false), resolve the promise with `null`.
     */
    onClose(): void {
        super.onClose();
        if (!this.submitted) {
            this.resolve(null);
        }
    }

    /**
     * Open the dialog and return a Promise that resolves with the user's choice.
     */
    open(): Promise<boolean | null> {
        super.open();
        return new Promise<boolean | null>((resolve) => {
            this.resolve = resolve;
        });
    }
}
