import type { Menu } from "obsidian";
import { PLUGIN_MODE, PluginModes } from "src/core/types";

export interface PluginRowMenuOptions {
    getMode: () => PLUGIN_MODE;
    isEnabled: () => boolean;
    onOpenDetails: () => void;
    onShowInCommunityPlugins: () => void;
    onRevealInExplorer: () => void;
    onToggleEnabled: (enabled: boolean) => void;
    onSelectMode: (mode: PLUGIN_MODE) => void;
}

const MODE_ORDER: PLUGIN_MODE[] = [PLUGIN_MODE.ALWAYS_DISABLED, PLUGIN_MODE.LAZY, PLUGIN_MODE.LAZY_ON_LAYOUT_READY, PLUGIN_MODE.ALWAYS_ENABLED];

/**
 * Builds the 3-dot row menu for the plugin management list.
 * The row itself stays a passive label + badge so mode changes never
 * rebuild the list (which would reset scroll and break infinite scroll).
 */
export function addPluginRowMenuItems(menu: Menu, options: PluginRowMenuOptions): void {
    // Both states stay visible like the Mode section. These change only the runtime
    // state (enablePlugin/disablePlugin), so the saved mode and the staged draft are untouched.
    const isEnabled = options.isEnabled();
    menu.addItem((item) => item.setTitle("Status (in memory only)").setDisabled(true));
    menu.addItem((item) =>
        item
            .setTitle("Enabled")
            .setChecked(isEnabled)
            .onClick(() => {
                if (!isEnabled) options.onToggleEnabled(true);
            }),
    );
    menu.addItem((item) =>
        item
            .setTitle("Disabled")
            .setChecked(!isEnabled)
            .onClick(() => {
                if (isEnabled) options.onToggleEnabled(false);
            }),
    );

    menu.addSeparator();

    menu.addItem((item) =>
        item
            .setTitle("Lazy settings")
            .setIcon("gear")
            .onClick(() => options.onOpenDetails()),
    );

    menu.addItem((item) =>
        item
            .setTitle("Show in system explorer")
            .setIcon("folder-open")
            .onClick(() => options.onRevealInExplorer()),
    );

    // Replace the external community page action with navigation to Obsidian's built-in tab.
    menu.addItem((item) =>
        item
            .setTitle("Show in Community plugins")
            .setIcon("list")
            .onClick(() => options.onShowInCommunityPlugins()),
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
