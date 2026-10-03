import type { App, PluginManifest } from "obsidian";
import { FuzzySuggestModal } from "obsidian";

/** Display format requested for the picker rows: NAME (id - author). */
export function formatPluginChoice(manifest: PluginManifest): string {
    return `${manifest.name} (${manifest.id} - ${manifest.author})`;
}

/**
 * Fuzzy picker over plugin manifests.
 * Stays a dumb view: filtering and toggling live in the feature so the
 * modal needs no knowledge of persist vs in-memory semantics.
 */
export class PluginPickerModal extends FuzzySuggestModal<PluginManifest> {
    private choices: PluginManifest[];
    private onChoose: (manifest: PluginManifest) => void;

    constructor(app: App, choices: PluginManifest[], placeholder: string, onChoose: (manifest: PluginManifest) => void) {
        super(app);
        this.choices = choices;
        this.onChoose = onChoose;
        this.setPlaceholder(placeholder);
    }

    getItems(): PluginManifest[] {
        return this.choices;
    }

    getItemText(manifest: PluginManifest): string {
        return formatPluginChoice(manifest);
    }

    onChooseItem(manifest: PluginManifest): void {
        this.onChoose(manifest);
    }
}
