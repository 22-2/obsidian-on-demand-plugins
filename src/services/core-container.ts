/**
 * ServiceContainer — Composition Root
 *
 * Creates and wires all services together. This is the single place
 * where the object graph is assembled, replacing the ad-hoc callback
 * wiring that was previously spread across main.ts.
 */
import type { PluginContext } from "src/core/plugin-context";
import { DEFAULT_DEVICE_SETTINGS, PLUGIN_MODE } from "src/core/types";
import { patchPluginEnableDisable } from "src/patches/plugin-enable-disable";
import { PluginRegistry } from "src/services/registry/plugin-registry";
import { SettingsService } from "src/services/settings/settings-service";

export class CoreContainer {
    readonly registry: PluginRegistry;
    readonly settingsService: SettingsService;

    constructor(private ctx: PluginContext) {
        // 1. Registry (no service deps)
        this.registry = new PluginRegistry(ctx.app, ctx.obsidianPlugins);

        // 2. Settings (no service deps)
        this.settingsService = new SettingsService(
            // SettingsService expects a Plugin, we pass it through the context adapter
            ctx._plugin,
        );
    }

    /**
     * Perform all initialization that was previously in OnDemandPlugin.onload().
     * Assumes settings and registry manifests have already been loaded.
     */
    async initialize() {
        // Load enabled-plugins list from disk
        await this.registry.loadEnabledPluginsFromDisk(this.settingsService.data.showConsoleLog);

        // Handle initial load profile creation & backups
        await this.handleInstallationAndBackups();

        // Apply monkey-patches
        patchPluginEnableDisable(this.ctx);
    }

    private async handleInstallationAndBackups() {
        // Initial setup
        if (this.settingsService.isFirstLoad) {
            const profileId = "initial-backup";
            const currentPlugins = Array.from(this.registry.enabledPluginsFromDisk);

            // Generate a safe copy of default settings
            const backupSettings = JSON.parse(JSON.stringify(DEFAULT_DEVICE_SETTINGS));

            // Set all currently enabled plugins to ALWAYS_ENABLED in this profile
            currentPlugins.forEach((id) => {
                backupSettings.plugins[id] = {
                    mode: PLUGIN_MODE.ALWAYS_ENABLED,
                    userConfigured: true,
                };
            });

            this.settingsService.data.profiles[profileId] = {
                id: profileId,
                name: "Backup: Initial State",
                settings: backupSettings,
            };

            // Create an initial file backup
            await this.ctx.saveSettings();
            return;
        }

        // Version update backup check

        const currentVersion = this.ctx._plugin.manifest.version;
        const savedVersion = this.settingsService.data.lastLazyPluginVersion;

        if (savedVersion !== currentVersion) {
            this.settingsService.data.lastLazyPluginVersion = currentVersion;
            await this.ctx.saveSettings();
        }
    }

    destroy() {
        this.registry?.clear();
    }
}
