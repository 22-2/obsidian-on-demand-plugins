import log from "loglevel";
import type { App, PluginManifest } from "obsidian";
import { Platform } from "obsidian";
import { ON_DEMAND_PLUGIN_ID } from "src/core/constants";

const logger = log.getLogger("OnDemandPlugin/PluginRegistry");

export class PluginRegistry {
    // Keep explicit member fields because erasableSyntaxOnly disallows constructor parameter properties.
    private app: App;
    private obsidianPlugins: {
        manifests: Record<string, PluginManifest>;
        enabledPlugins: Set<string>;
    };

    manifests: PluginManifest[] = [];
    enabledPluginsFromDisk = new Set<string>();

    constructor(
        app: App,
        obsidianPlugins: {
            manifests: Record<string, PluginManifest>;
            enabledPlugins: Set<string>;
        },
    ) {
        this.app = app;
        this.obsidianPlugins = obsidianPlugins;
    }

    reloadManifests() {
        const manifests = Object.values(this.obsidianPlugins.manifests);
        this.manifests = manifests
            .filter(
                (plugin: PluginManifest) =>
                    // Filter out the Lazy Loader plugin
                    plugin.id !== ON_DEMAND_PLUGIN_ID &&
                    // Filter out desktop-only plugins from mobile
                    !(Platform.isMobile && plugin.isDesktopOnly),
            )
            .sort((a: PluginManifest, b: PluginManifest) => a.name.localeCompare(b.name));
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return this.enabledPluginsFromDisk.has(pluginId) || this.obsidianPlugins.enabledPlugins.has(pluginId);
    }

    getCommunityPluginsConfigFilePath() {
        return this.app.vault.getConfigFile("community-plugins");
    }

    async loadEnabledPluginsFromDisk(showConsoleLog?: boolean) {
        this.enabledPluginsFromDisk.clear();

        try {
            const parsed = await this.app.vault.readConfigJson("community-plugins");
            if (Array.isArray(parsed)) {
                parsed.forEach((id: unknown) => {
                    if (typeof id === "string") this.enabledPluginsFromDisk.add(id);
                });
            }
        } catch (error) {
            if (showConsoleLog) {
                logger.warn("Failed to read community-plugins.json using readConfigJson", error);
            }
        }
    }

    async writeCommunityPluginsFile(enabledPlugins: string[], showConsoleLog?: boolean) {
        try {
            await this.app.vault.writeConfigJson("community-plugins", enabledPlugins);
        } catch (error) {
            if (showConsoleLog) {
                logger.error("Failed to write community-plugins.json using writeConfigJson", error);
            }
        }
    }

    clear() {
        this.manifests = [];
        this.enabledPluginsFromDisk.clear();
    }
}
