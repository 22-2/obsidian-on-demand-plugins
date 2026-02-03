import { Platform, Plugin } from "obsidian";
import {
    DEFAULT_DEVICE_SETTINGS,
    DEFAULT_SETTINGS,
    DeviceSettings,
    LazySettings,
    PluginMode,
} from "../settings";

export class SettingsService {
    data: LazySettings;
    settings: DeviceSettings;
    device = "desktop/global";

    constructor(private plugin: Plugin) {}

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
    }

    async save() {
        await this.plugin.saveData(this.data);
    }

    async migrate() {
        let hasChanges = false;
        const settings = this.settings as DeviceSettings & {
            defaultKeepEnabled?: boolean;
        };

        if (!settings.plugins) {
            settings.plugins = {};
            hasChanges = true;
        }

        if (
            settings.defaultMode === undefined &&
            settings.defaultKeepEnabled !== undefined
        ) {
            settings.defaultMode = settings.defaultKeepEnabled
                ? "keepEnabled"
                : "disabled";
            delete settings.defaultKeepEnabled;
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
