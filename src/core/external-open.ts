import { Platform } from "obsidian";

type ElectronShell = {
    openPath: (path: string) => Promise<string>;
};

function getElectronShell(): ElectronShell | undefined {
    // Electron is absent on mobile; keep its runtime lookup in one place so shared UI code can load there.
    if (!Platform.isDesktopApp) return undefined;
    const electron = (window as Window & { require?: (moduleName: string) => unknown }).require?.("electron") as { shell?: ElectronShell } | undefined;
    return electron?.shell;
}

export async function openSystemPath(path: string): Promise<string> {
    const shell = getElectronShell();
    if (!shell) throw new Error("Electron shell is unavailable.");
    return shell.openPath(path);
}
