import { App, Modal } from "obsidian";

/**
 * 確認モーダルを表示し、ユーザーの選択結果を返却します。
 *
 * - 「はい」が選択された場合は true
 * - 「キャンセル」が選択された場合は false
 * - 明示的な操作なしに閉じられた場合は null
 *
 * ```ts
 * const result = await showConfirmModal({ message: "この操作を実行しますか？" });
 * if (result === true) {
 *     // はいが押された
 * }
 * ```
 */
export async function showConfirmModal(app: App, args: {
	message: string;
}): Promise<boolean | null> {
	return new ConfirmModal(app, args.message).open();
}

export class ConfirmModal extends Modal {
	submitted = false;
	// Promiseを解決するための関数
	resolve!: (value: boolean | null) => void;

	constructor(app: App, public message: string) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("確認");

		// メッセージ表示
		this.contentEl.createEl("p", { text: this.message });

		// ボタンコンテナ
		const buttonContainer = this.contentEl.createDiv("modal-button-container");

		// --- はい/OKボタン ---
		const confirmButton = buttonContainer.createEl("button", {
			text: "はい",
			cls: "mod-cta", // メインの行動を目立たせるスタイル
		});

		const handleConfirm = () => {
			this.resolve(true);
			this.submitted = true;
			this.close();
		};

		confirmButton.onClickEvent(handleConfirm);

		// Enterキーで「はい」をデフォルトにする
		this.scope.register(null, "Enter", handleConfirm);

		// --- キャンセルボタン ---
		const cancelButton = buttonContainer.createEl("button", {
			text: "キャンセル",
		});
		cancelButton.onClickEvent(() => {
			this.resolve(false);
			this.submitted = true;
			this.close();
		});
	}

	/**
	 * モーダルが閉じられたときに呼び出されます。
	 * submitted フラグが立っていなければ、ESCなどで閉じられたとみなし null を返します。
	 */
	onClose(): void {
		super.onClose();
		if (!this.submitted) {
			this.resolve(null);
		}
	}

	/**
	 * ダイアログを開き、Promiseを返却します。
	 */
	open(): Promise<boolean | null> {
		super.open();
		return new Promise<boolean | null>((resolve) => {
			this.resolve = resolve;
		});
	}
}
