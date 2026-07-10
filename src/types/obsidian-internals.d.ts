import type { Commands, Plugins, ViewRegistry } from "obsidian-typings";

declare module "obsidian" {
    interface App {
        appId: string;
        plugins: Plugins;
        commands: Commands;
        updateRibbonDisplay: () => void;
        viewRegistry: ViewRegistry;
    }

    interface Vault {
        getConfigFile(name: string): string;
        readConfigJson(name: string): Promise<unknown>;
        writeConfigJson(name: string, data: unknown): Promise<void>;
    }

    interface WorkspaceLeaf {
        id: string;
    }

    interface MarkdownView {
        inlineTitleEl: HTMLElement;
        titleEl: HTMLElement;
    }
}

export { };
