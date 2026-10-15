import type { PendingChange } from "src/ui/settings/pending-changes";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockElement = {
    className: string;
    text: string;
    checked?: boolean;
    children: MockElement[];
    clickHandler?: () => void;
    addClass: (className: string) => void;
    setText: (text: string) => void;
    empty: () => void;
    createDiv: (options?: { cls?: string; text?: string }) => MockElement;
    createEl: (tag: string, options?: { cls?: string; text?: string }) => MockElement;
    createSpan: (options?: { cls?: string; text?: string }) => MockElement;
    onClickEvent: (callback: () => void) => MockElement;
};

type MockModal = {
    modalEl: MockElement;
    titleEl: MockElement;
    contentEl: MockElement;
    closeCalls: number;
    open: () => void;
    close: () => void;
    onOpen: () => void;
    onClose: () => void;
};

const mockState = vi.hoisted(() => ({
    modals: [] as MockModal[],
    extraButtonCallbacks: [] as Array<() => void>,
    extraButtonCalls: [] as string[],
    setIcon: vi.fn(),
}));

vi.mock("obsidian", () => {
    function createElement(options: { cls?: string; text?: string } = {}): MockElement {
        return {
            className: options.cls ?? "",
            text: options.text ?? "",
            children: [],
            addClass(className) {
                this.className = `${this.className} ${className}`.trim();
            },
            setText(text) {
                this.text = text;
            },
            empty() {
                this.children = [];
            },
            createDiv(childOptions = {}) {
                const child = createElement(childOptions);
                this.children.push(child);
                return child;
            },
            createEl(_tag, childOptions = {}) {
                const child = createElement(childOptions);
                this.children.push(child);
                return child;
            },
            createSpan(childOptions = {}) {
                const child = createElement(childOptions);
                this.children.push(child);
                return child;
            },
            onClickEvent(callback) {
                this.clickHandler = callback;
                return this;
            },
        };
    }

    class MockModal {
        modalEl = createElement();
        titleEl = createElement();
        contentEl = createElement();
        closeCalls = 0;

        constructor() {
            mockState.modals.push(this);
        }

        open() {
            this.onOpen();
        }

        close() {
            this.closeCalls++;
            this.onClose();
        }

        onOpen() {}

        onClose() {}
    }

    class MockExtraButtonComponent {
        setIcon(icon: string) {
            mockState.extraButtonCalls.push(`icon:${icon}`);
            return this;
        }

        setTooltip(tooltip: string) {
            mockState.extraButtonCalls.push(`tooltip:${tooltip}`);
            return this;
        }

        onClick(callback: () => void) {
            mockState.extraButtonCallbacks.push(callback);
            return this;
        }
    }

    return { ExtraButtonComponent: MockExtraButtonComponent, Modal: MockModal, setIcon: mockState.setIcon };
});

const { showRestoreDraftModal, showReviewChangesModal } = await import("src/ui/modals/review-changes-modal");

function findElements(root: MockElement, className: string): MockElement[] {
    return [...(root.className.split(" ").includes(className) ? [root] : []), ...root.children.flatMap((child) => findElements(child, className))];
}

function allElements(root: MockElement): MockElement[] {
    return [root, ...root.children.flatMap(allElements)];
}

describe("showReviewChangesModal", () => {
    beforeEach(() => {
        mockState.modals.length = 0;
        mockState.extraButtonCallbacks.length = 0;
        mockState.extraButtonCalls.length = 0;
        vi.clearAllMocks();
    });

    it("groups save changes, supports reverting one item, and resolves true on confirmation", async () => {
        const changes: PendingChange[] = [];
        const revertPlugin = vi.fn(() => changes.splice(0, 1));
        changes.push({ group: "plugins", label: "Sample plugin", from: "Lazy", to: "Enabled", revert: revertPlugin }, { group: "settings", label: "Default mode", from: "Lazy", to: "Enabled" }, { group: "profiles", label: "Desktop default profile", from: "Work", to: "Home" }, { group: "profiles", label: "New profile", to: "Travel" });
        const getChanges = vi.fn(() => changes);
        const result = showReviewChangesModal({} as never, { mode: "save", getChanges, getConfirmLabel: () => "Save changes" });
        const modal = mockState.modals[0];

        expect(modal?.modalEl.className).toContain("lazy-review-changes-modal");
        expect(modal?.titleEl.text).toBe("Review changes");
        expect(findElements(modal.contentEl, "lazy-review-changes-group").map((element) => element.text)).toEqual(["Plugins (1)", "Settings (1)", "Profiles (2)"]);
        expect(findElements(modal.contentEl, "lazy-review-changes-note")[0]?.text).toBe("Plugin mode changes are applied when saved.");
        expect(mockState.setIcon).toHaveBeenCalledWith(expect.anything(), "arrow-right");
        expect(mockState.extraButtonCalls).toEqual(["icon:rotate-ccw", "tooltip:Revert this change"]);

        mockState.extraButtonCallbacks[0]?.();

        expect(revertPlugin).toHaveBeenCalledOnce();
        expect(getChanges).toHaveBeenCalledTimes(2);
        expect(findElements(modal.contentEl, "lazy-review-changes-group").map((element) => element.text)).toEqual(["Settings (1)", "Profiles (2)"]);

        const confirmButton = allElements(modal.contentEl).find((element) => element.className.split(" ").includes("mod-cta"));
        confirmButton?.clickHandler?.();

        await expect(result).resolves.toBe(true);
        expect(modal?.closeCalls).toBe(1);
    });

    it("previews discarded values and resolves false when canceled", async () => {
        const changes: PendingChange[] = [
            { group: "plugins", label: "Existing plugin", from: "Lazy", to: "Disabled" },
            { group: "settings", label: "New option", to: "Enabled" },
        ];
        const result = showReviewChangesModal({} as never, {
            mode: "discard",
            getChanges: () => changes,
            getConfirmLabel: () => "Discard changes",
        });
        const modal = mockState.modals[0];
        const confirmButton = allElements(modal.contentEl).find((element) => element.className.split(" ").includes("mod-warning"));
        const cancelButton = allElements(modal.contentEl).find((element) => element.text === "Cancel");

        expect(modal?.titleEl.text).toBe("Discard changes");
        expect(findElements(modal.contentEl, "lazy-review-changes-note")[0]?.text).toBe("These changes will be lost and the saved settings restored.");
        expect(findElements(modal.contentEl, "lazy-review-changes-lost").map((element) => element.text)).toEqual(["Disabled", "Enabled"]);
        expect(findElements(modal.contentEl, "lazy-review-changes-restore-label")).toHaveLength(1);
        expect(findElements(modal.contentEl, "lazy-review-changes-to").map((element) => element.text)).toEqual(["Lazy"]);
        expect(confirmButton).toBeDefined();
        expect(mockState.extraButtonCallbacks).toHaveLength(0);

        cancelButton?.clickHandler?.();

        await expect(result).resolves.toBe(false);
        expect(modal?.closeCalls).toBe(1);
    });

    it("closes without confirmation when the last change is reverted", async () => {
        const changes: PendingChange[] = [];
        const revertLastChange = vi.fn(() => changes.pop());
        changes.push({ group: "plugins", label: "Sample plugin", to: "Disabled", revert: revertLastChange });
        const getChanges = vi.fn(() => changes);
        const result = showReviewChangesModal({} as never, {
            mode: "save",
            getChanges,
            getConfirmLabel: () => "Save changes",
        });
        const modal = mockState.modals[0];
        mockState.extraButtonCallbacks[0]?.();

        await expect(result).resolves.toBe(false);
        expect(revertLastChange).toHaveBeenCalledOnce();
        expect(getChanges).toHaveBeenCalledTimes(2);
        expect(modal?.closeCalls).toBe(1);
    });

    describe("restore mode", () => {
        const changes: PendingChange[] = [{ group: "plugins", label: "Sample plugin", from: "Lazy", to: "Enabled", revert: vi.fn() }];
        const button = (modal: MockModal, text: string) => allElements(modal.contentEl).find((element) => element.text === text);

        it("offers the unsaved draft without single reverts and resolves restore", async () => {
            const result = showRestoreDraftModal({} as never, () => changes);
            const modal = mockState.modals[0];

            expect(modal.titleEl.text).toBe("Restore unsaved changes");
            expect(findElements(modal.contentEl, "lazy-review-changes-note")[0]?.text).toBe("These unsaved changes were set aside when you left On-Demand settings. Restore them to keep editing, or discard them.");
            expect(mockState.extraButtonCalls).toEqual([]);
            button(modal, "Restore (1)")?.clickHandler?.();

            await expect(result).resolves.toEqual({ action: "restore", dontAskAgain: false });
        });

        it("resolves discard from the Discard button", async () => {
            const result = showRestoreDraftModal({} as never, () => changes);
            button(mockState.modals[0], "Discard")?.clickHandler?.();
            await expect(result).resolves.toEqual({ action: "discard", dontAskAgain: false });
        });

        it("returns the remember choice with the selected action", async () => {
            const result = showRestoreDraftModal({} as never, () => changes);
            const modal = mockState.modals[0];
            const checkbox = findElements(modal.contentEl, "lazy-restore-draft-remember")[0]?.children[0];
            expect(findElements(modal.contentEl, "lazy-restore-draft-remember")[0]?.children[1]?.text).toBe("Don't ask again");
            if (checkbox) checkbox.checked = true;
            button(modal, "Discard")?.clickHandler?.();
            await expect(result).resolves.toEqual({ action: "discard", dontAskAgain: true });
        });

        it("resolves dismiss when closed without a choice, so the draft can be offered again", async () => {
            const result = showRestoreDraftModal({} as never, () => changes);
            mockState.modals[0].close();
            await expect(result).resolves.toEqual({ action: "dismiss", dontAskAgain: false });
        });
    });
});
