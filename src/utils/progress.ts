import { App, Modal } from "obsidian";

export interface ProgressDialogOptions {
    title?: string;
    status?: string;
    total?: number;
    cancellable?: boolean;
    cancelText?: string;
    onCancel?: () => void;
}

export class ProgressDialog extends Modal {
    private progressEl: HTMLProgressElement;
    private counterEl: HTMLDivElement;
    private statusEl: HTMLDivElement;
    private total = 100;
    private current = 0;
    private onCancel?: () => void;

    constructor(app: App, options: ProgressDialogOptions = {}) {
        super(app);
        this.modalEl.addClass("lazy-plugin-progress");

        this.onCancel = options.onCancel;
        this.total = options.total ?? this.total;

        this.titleEl.setText(options.title ?? "Working…");
        this.contentEl.empty();

        this.statusEl = this.contentEl.createDiv({
            cls: "lazy-plugin-progress-status",
            text: options.status ?? "",
        });

        this.progressEl = this.contentEl.createEl("progress", {
            cls: "lazy-plugin-progress-bar",
            attr: {
                max: String(this.total),
                value: "0",
            },
        });

        this.counterEl = this.contentEl.createDiv({
            cls: "lazy-plugin-progress-counter",
            text: "0%",
        });

        if (options.cancellable) {
            const cancelButton = this.contentEl.createEl("button", {
                text: options.cancelText ?? "Cancel",
            });
            cancelButton.addEventListener("click", () => {
                this.onCancel?.();
                this.close();
            });
        }
    }

    /**
     * Allow callers to set or replace the cancel handler after construction.
     */
    setOnCancel(onCancel?: () => void) {
        this.onCancel = onCancel;
    }

    setTotal(total: number) {
        this.total = Math.max(1, Math.floor(total));
        this.progressEl.max = this.total;
        this.updateCounter();
    }

    setProgress(current: number, total?: number) {
        if (typeof total === "number") {
            this.setTotal(total);
        }
        this.current = Math.max(0, Math.min(current, this.total));
        this.progressEl.value = this.current;
        this.updateCounter();
    }

    increment(step = 1) {
        this.setProgress(this.current + step);
    }

    setStatus(text: string) {
        this.statusEl.setText(text);
    }

    private updateCounter() {
        const pct = this.total
            ? Math.round((this.current / this.total) * 100)
            : 0;
        this.counterEl.setText(`${pct}%`);
    }
}
