import type { Menu } from "obsidian";
import { PLUGIN_MODE, PluginModes } from "src/core/types";
import type { PLUGIN_MODE as PluginMode } from "src/core/types";

export interface PluginRowMenuOptions {
    getMode: () => PluginMode;
    onOpenDetails: () => void;
    onToggleEnabled: (enabled: boolean) => void;
    onSelectMode: (mode: PluginMode) => void;
}

const MODE_ORDER: PluginMode[] = [
    PLUGIN_MODE.ALWAYS_DISABLED,
    PLUGIN_MODE.LAZY,
    PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
    PLUGIN_MODE.ALWAYS_ENABLED,
];

/**
 * Builds the 3-dot row menu for the plugin management list.
 * The row itself stays a passive label + badge so mode changes never
 * rebuild the list (which would reset scroll and break infinite scroll).
 */
export function addPluginRowMenuItems(menu: Menu, options: PluginRowMenuOptions): void {
    menu.addItem((item) =>
        item
            .setTitle("Details")
            .setIcon("gear")
            .onClick(() => options.onOpenDetails()),
    );

    // Shortcut for the most common toggle; fine-grained choice lives below.
    const isDisabled = options.getMode() === PLUGIN_MODE.ALWAYS_DISABLED;
    menu.addItem((item) =>
        item
            .setTitle(isDisabled ? "Enable plugin" : "Disable plugin")
            .setIcon(isDisabled ? "toggle-right" : "toggle-left")
            .onClick(() => options.onToggleEnabled(!isDisabled)),
    );

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Mode").setDisabled(true));
    const current = options.getMode();
    for (const mode of MODE_ORDER) {
        menu.addItem((item) =>
            item
                .setTitle(PluginModes[mode])
                .setChecked(mode === current)
                .onClick(() => options.onSelectMode(mode)),
        );
    }
}
