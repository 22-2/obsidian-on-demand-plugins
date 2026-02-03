import { App, Platform, PluginManifest } from "obsidian";
import { lazyPluginId } from "../constants";

export class PluginRegistry {
    manifests: PluginManifest[] = [];
    enabledPluginsFromDisk = new Set<string>();

    constructor(
        private app: App,
        private obsidianPlugins: {
            manifests: Record<string, PluginManifest>;
            enabledPlugins: Set<string>;
        },
    ) {}

    updateManifests() {
        const manifests = Object.values(this.obsidianPlugins.manifests);
        this.manifests = manifests
            .filter(
                (plugin: PluginManifest) =>
                    // Filter out the Lazy Loader plugin
                    plugin.id !== lazyPluginId &&
                    // Filter out desktop-only plugins from mobile
                    !(Platform.isMobile && plugin.isDesktopOnly),
            )
            .sort((a: PluginManifest, b: PluginManifest) =>
                a.name.localeCompare(b.name),
            );
    }

    isPluginEnabledOnDisk(pluginId: string): boolean {
        return (
            this.enabledPluginsFromDisk.has(pluginId) ||
            this.obsidianPlugins.enabledPlugins.has(pluginId)
        );
    }

    async loadEnabledPluginsFromDisk(showConsoleLog?: boolean) {
        const adapter = this.app.vault.adapter;
        const path = ".obsidian/community-plugins.json";
        this.enabledPluginsFromDisk.clear();

        try {
            const raw = await adapter.read(path);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                parsed.forEach((id) => {
                    if (typeof id === "string")
                        this.enabledPluginsFromDisk.add(id);
                });
            }
        } catch (error) {
            if (showConsoleLog) {
                console.warn("Failed to read community-plugins.json", error);
            }
        }
    }

    async writeCommunityPluginsFile(
        enabledPlugins: string[],
        showConsoleLog?: boolean,
    ) {
        const adapter = this.app.vault.adapter;
        const path = ".obsidian/community-plugins.json";
        const content = JSON.stringify(enabledPlugins, null, "\t");

        try {
            await adapter.write(path, content);
        } catch (error) {
            if (showConsoleLog) {
                console.error("Failed to write community-plugins.json", error);
            }
        }
    }

    clear() {
        this.manifests = [];
        this.enabledPluginsFromDisk.clear();
    }
}
