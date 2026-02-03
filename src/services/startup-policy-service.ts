import { App, PluginManifest } from "obsidian";
import { ProgressDialog } from "../progress";
import { lazyPluginId } from "../constants";
import { PluginMode } from "../settings";

interface StartupPolicyDeps {
  app: App;
  getManifests: () => PluginManifest[];
  getPluginMode: (pluginId: string) => PluginMode;
  applyPluginState: (pluginId: string) => Promise<void>;
  writeCommunityPluginsFile: (enabledPlugins: string[]) => Promise<void>;
}

export class StartupPolicyService {
  private startupPolicyLock: Promise<void> | null = null;
  private startupPolicyPending = false;
  private startupPolicyDebounceTimer: number | null = null;
  private startupPolicyDebounceMs = 100;

  constructor(private deps: StartupPolicyDeps) {}

  async apply(showProgress = false) {
    if (this.startupPolicyLock) {
      this.startupPolicyPending = true;
      await this.startupPolicyLock;
      if (this.startupPolicyPending) {
        this.startupPolicyPending = false;
        await this.apply(showProgress);
      }
      return;
    }

    const run = async () => {
      if (this.startupPolicyDebounceTimer) {
        window.clearTimeout(this.startupPolicyDebounceTimer);
      }

      await new Promise<void>((resolve) => {
        this.startupPolicyDebounceTimer = window.setTimeout(() => {
          this.startupPolicyDebounceTimer = null;
          resolve();
        }, this.startupPolicyDebounceMs);
      });

      const desiredEnabled = new Set<string>();
      this.deps.getManifests().forEach((plugin) => {
        if (this.deps.getPluginMode(plugin.id) === "keepEnabled") {
          desiredEnabled.add(plugin.id);
        }
      });
      desiredEnabled.add(lazyPluginId);

      await this.deps.writeCommunityPluginsFile(
        [...desiredEnabled].sort((a, b) => a.localeCompare(b)),
      );

      let progress: ProgressDialog | null = null;
      if (showProgress) {
        progress = new ProgressDialog(this.deps.app, {
          title: "Applying plugin startup policy",
          total: this.deps.getManifests().length,
        });
        progress.open();
      }

      try {
        let index = 0;
        for (const plugin of this.deps.getManifests()) {
          index += 1;
          progress?.setStatus(`Applying ${plugin.name}`);
          progress?.setProgress(index);
          await this.deps.applyPluginState(plugin.id);
        }
      } finally {
        progress?.close();
      }
    };

    this.startupPolicyLock = run();
    try {
      await this.startupPolicyLock;
    } finally {
      this.startupPolicyLock = null;
    }

    if (this.startupPolicyPending) {
      this.startupPolicyPending = false;
      await this.apply(showProgress);
    }
  }
}
