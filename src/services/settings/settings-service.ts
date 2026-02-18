import { Platform } from "obsidian";
import OnDemandPlugin from "src/main";
import { loadJSON } from "../../core/storage";
import {
    DEFAULT_DEVICE_SETTINGS,
    DEFAULT_SETTINGS,
    DeviceSettings,
    LazySettings,
    PluginMode,
} from "../../core/types";

export class SettingsService {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";

    constructor(private plugin: OnDemandPlugin) {}

    async load() {
        this.data = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.plugin.loadData(),
        );
        // Object.assign only works 1 level deep, so need to clone the sub-level as well
        this.data.desktop = Object.assign(
            {},
            DEFAULT_DEVICE_SETTINGS,
            this.data.desktop,
        );

        // If user has dual mobile/desktop settings enabled
        if (this.data.dualConfigs && Platform.isMobile) {
            if (!this.data.mobile) {
                // No existing configuration - copy the desktop one
                this.data.mobile = JSON.parse(
                    JSON.stringify(this.data.desktop),
                ) as DeviceSettings;
            } else {
                this.data.mobile = Object.assign(
                    {},
                    DEFAULT_DEVICE_SETTINGS,
                    this.data.mobile,
                );
            }
            this.settings = this.data.mobile;
            this.device = "mobile";
        } else {
            this.settings = this.data.desktop;
            this.device = "desktop/global";
        }

        // Try to hydrate lazyOnViews from local store2 cache (vault-specific) if available
        const stored = loadJSON<Record<string, string[]>>(
            this.plugin.app,
            "lazyOnViews",
        );
        if (stored && Object.keys(stored).length > 0) {
            if (!this.data.desktop) this.data.desktop = DEFAULT_DEVICE_SETTINGS;
            this.data.desktop.lazyOnViews = {
                ...(this.data.desktop.lazyOnViews ?? {}),
                ...(stored as { [k: string]: string[] }),
            };
            this.settings = this.data.desktop;
        }
    }

    async save() {
        await this.plugin.saveData(this.data);
    }

    async migrate() {
        let hasChanges = false;
        const settings = this.settings as DeviceSettings;

        if (!settings.plugins) {
            settings.plugins = {};
            hasChanges = true;
        }

        Object.entries(settings.plugins).forEach(
            ([pluginId, pluginSettings]) => {
                const legacy = pluginSettings as {
                    keepEnabled?: boolean;
                    mode?: PluginMode;
                };
                if (
                    legacy.mode === undefined &&
                    legacy.keepEnabled !== undefined
                ) {
                    legacy.mode = legacy.keepEnabled
                        ? "keepEnabled"
                        : "disabled";
                    delete legacy.keepEnabled;
                    settings.plugins[pluginId] = legacy;
                    hasChanges = true;
                }
            },
        );

        if (hasChanges) {
            await this.save();
        }
    }
}
