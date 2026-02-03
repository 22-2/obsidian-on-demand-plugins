import { App, PluginManifest } from "obsidian";
import { ProgressDialog } from "../progress";
import { lazyPluginId } from "../constants";
import { PluginMode } from "../settings";

interface StartupPolicyDeps {
  app: App;
  obsidianPlugins: {
    enabledPlugins: Set<string>;
    plugins?: Record<string, { _loaded?: boolean }>;
    enablePlugin: (id: string) => Promise<void | boolean>;
  };
  getManifests: () => PluginManifest[];
  getPluginMode: (pluginId: string) => PluginMode;
  applyPluginState: (pluginId: string) => Promise<void>;
  writeCommunityPluginsFile: (enabledPlugins: string[]) => Promise<void>;
  getLazyWithViews: () => Record<string, string[]> | undefined;
  saveLazyWithViews: (next: Record<string, string[]>) => Promise<void>;
  ensurePluginLoaded: (pluginId: string) => Promise<boolean>;
  refreshCommandCache: () => Promise<void>;
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

      let progress: ProgressDialog | null = null;
      let cancelled = false;
      const manifests = this.deps.getManifests();
      const lazyManifests = manifests.filter((plugin) => {
        const mode = this.deps.getPluginMode(plugin.id);
        return mode === "lazy" || mode === "lazyWithView";
      });

      if (showProgress) {
        progress = new ProgressDialog(this.deps.app, {
          title: "Applying plugin startup policy",
          total: lazyManifests.length + 2,
          cancellable: true,
          cancelText: "Cancel",
          onCancel: () => {
            cancelled = true;
          },
        });
        progress.open();
      }

      const { viewRegistry } = this.deps.app as unknown as {
        viewRegistry?: {
          registerView?: (type: string, creator: unknown) => unknown;
        };
      };

      const lazyWithViews: Record<string, string[]> = {
        ...(this.deps.getLazyWithViews() ?? {}),
      };

      const originalRegisterView = viewRegistry?.registerView;
      if (viewRegistry && typeof originalRegisterView === "function") {
        viewRegistry.registerView = (type: string, creator: unknown) => {
          const loadingPluginId = (this.deps.app as unknown as { plugins?: any })
            ?.plugins?.loadingPluginId as string | undefined;

          if (
            loadingPluginId &&
            this.deps.getPluginMode(loadingPluginId) === "lazyWithView" &&
            typeof type === "string" &&
            type.length > 0
          ) {
            if (!lazyWithViews[loadingPluginId]) {
              lazyWithViews[loadingPluginId] = [];
            }
            if (!lazyWithViews[loadingPluginId].includes(type)) {
              lazyWithViews[loadingPluginId].push(type);
            }
          }

          return originalRegisterView.apply(viewRegistry, [type, creator]);
        };
      }

      try {
        if (!showProgress) {
          let index = 0;
          for (const plugin of manifests) {
            index += 1;
            progress?.setStatus(`Applying ${plugin.name}`);
            progress?.setProgress(index);
            if (this.deps.getPluginMode(plugin.id) === "lazyWithView") {
              await this.deps.ensurePluginLoaded(plugin.id);
            }
            await this.deps.applyPluginState(plugin.id);
          }
        } else {
          let index = 0;
          for (const plugin of lazyManifests) {
            if (cancelled) break;
            index += 1;
            progress?.setStatus(`Loading ${plugin.name}`);
            progress?.setProgress(index);

            const isLoaded =
              this.deps.obsidianPlugins.plugins?.[plugin.id]?._loaded;
            const isEnabled = this.deps.obsidianPlugins.enabledPlugins.has(
              plugin.id,
            );
            if (!isEnabled || !isLoaded) {
              try {
                await this.deps.obsidianPlugins.enablePlugin(plugin.id);
              } catch (error) {
                console.warn("Failed to load plugin", plugin.id, error);
              }
            }
          }

          if (!cancelled) {
            progress?.setStatus("Waiting for plugins to finish registering…");
            const pluginIds = lazyManifests.map((plugin) => plugin.id);
            await this.waitForAllPluginsLoaded(pluginIds, 60000);
            progress?.setProgress(lazyManifests.length + 1);

            await new Promise<void>((resolve) => {
              window.setTimeout(() => resolve(), 2500);
            });
          }

          if (!cancelled) {
            progress?.setStatus("Rebuilding command cache…");
            await this.deps.refreshCommandCache();
            progress?.setProgress(lazyManifests.length + 2);
          }
        }
      } finally {
        if (viewRegistry && originalRegisterView) {
          viewRegistry.registerView = originalRegisterView;
        }
        for (const plugin of this.deps.getManifests()) {
          if (this.deps.getPluginMode(plugin.id) !== "lazyWithView") {
            delete lazyWithViews[plugin.id];
          }
        }
        await this.deps.saveLazyWithViews(lazyWithViews);

        const desiredEnabled = new Set<string>();
        this.deps.getManifests().forEach((plugin) => {
          if (this.deps.getPluginMode(plugin.id) === "keepEnabled") {
            desiredEnabled.add(plugin.id);
          }
        });
        desiredEnabled.add(lazyPluginId);

        this.deps.obsidianPlugins.enabledPlugins.clear();
        desiredEnabled.forEach((pluginId) => {
          this.deps.obsidianPlugins.enabledPlugins.add(pluginId);
        });

        await this.deps.writeCommunityPluginsFile(
          [...desiredEnabled].sort((a, b) => a.localeCompare(b)),
        );

        if (showProgress && !cancelled) {
          try {
            await (this.deps.app as any)?.commands?.executeCommandById?.(
              "app:reload",
            );
          } catch (error) {
            console.warn("Failed to reload app after apply", error);
          }
        }
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

  private async waitForAllPluginsLoaded(
    pluginIds: string[],
    timeoutMs = 60000,
  ): Promise<boolean> {
    if (!pluginIds.length) return true;

    const startedAt = Date.now();
    const isLoaded = (pluginId: string) =>
      Boolean(this.deps.obsidianPlugins.plugins?.[pluginId]?._loaded);

    while (true) {
      if (pluginIds.every((pluginId) => isLoaded(pluginId))) {
        return true;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 100);
      });
    }
  }
}
