import { App, Editor, MarkdownView } from "obsidian";
import { LazySettings } from "../settings";
import { CachedCommand } from "./command-cache-service";

interface LazyCommandRunnerDeps {
  app: App;
  obsidianCommands: { commands: Record<string, unknown> };
  obsidianPlugins: {
    enabledPlugins: Set<string>;
    plugins?: Record<string, { _loaded?: boolean }>;
    enablePlugin: (id: string) => Promise<void>;
  };
  getCachedCommand: (commandId: string) => CachedCommand | undefined;
  removeCachedCommandsForPlugin: (pluginId: string) => void;
  getData: () => LazySettings;
}

export class LazyCommandRunner {
  private inFlightPlugins = new Set<string>();

  constructor(private deps: LazyCommandRunnerDeps) {}

  clear() {
    this.inFlightPlugins.clear();
  }

  async runLazyCommand(commandId: string) {
    const cached = this.deps.getCachedCommand(commandId);
    if (!cached) return;

    if (this.inFlightPlugins.has(cached.pluginId)) return;
    this.inFlightPlugins.add(cached.pluginId);

    try {
      const isLoaded = this.deps.obsidianPlugins.plugins?.[cached.pluginId]?._loaded;
      if (
        !this.deps.obsidianPlugins.enabledPlugins.has(cached.pluginId) ||
        !isLoaded
      ) {
        this.deps.removeCachedCommandsForPlugin(cached.pluginId);
        await this.deps.obsidianPlugins.enablePlugin(cached.pluginId);
        const loaded = await this.waitForPluginLoaded(cached.pluginId);
        if (!loaded) return;
        const ready = await this.waitForCommand(cached.id);
        if (!ready) return;
      }

      if (this.deps.getData().showConsoleLog) {
        console.log(`Executing lazy command: ${cached.id}`);
      }

      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          this.executeCommandDirect(cached.id);
          resolve();
        });
      });
    } catch (error) {
      if (this.deps.getData().showConsoleLog) {
        console.error(`Error executing lazy command ${commandId}:`, error);
      }
    } finally {
      this.inFlightPlugins.delete(cached.pluginId);
    }
  }

  async waitForCommand(commandId: string, timeoutMs = 8000): Promise<boolean> {
    if (this.isCommandExecutable(commandId)) return true;

    return await new Promise<boolean>((resolve) => {
      const viewRegistry = (this.deps.app as unknown as { viewRegistry?: any })
        .viewRegistry;
      let done = false;

      const cleanup = () => {
        if (done) return;
        done = true;
        if (viewRegistry?.off) viewRegistry.off("view-registered", onEvent);
        if (this.deps.app.workspace?.off)
          this.deps.app.workspace.off("layout-change", onEvent);
        if (timeoutId) window.clearTimeout(timeoutId);
      };

      const onEvent = () => {
        if (this.isCommandExecutable(commandId)) {
          cleanup();
          resolve(true);
        }
      };

      if (viewRegistry?.on) viewRegistry.on("view-registered", onEvent);
      if (this.deps.app.workspace?.on)
        this.deps.app.workspace.on("layout-change", onEvent);

      queueMicrotask(onEvent);

      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });
  }

  async waitForPluginLoaded(
    pluginId: string,
    timeoutMs = 8000,
  ): Promise<boolean> {
    const isLoaded = () =>
      Boolean(this.deps.obsidianPlugins.plugins?.[pluginId]?._loaded);
    if (isLoaded()) return true;

    return await new Promise<boolean>((resolve) => {
      const startedAt = Date.now();
      let timeoutId: number | null = null;

      const check = () => {
        if (isLoaded()) {
          if (timeoutId) window.clearTimeout(timeoutId);
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        timeoutId = window.setTimeout(check, 100);
      };

      check();
    });
  }

  executeCommandDirect(commandId: string): boolean {
    const command = this.deps.obsidianCommands.commands[commandId] as
      | {
          callback?: () => void;
          checkCallback?: (checking: boolean) => boolean | void;
          editorCallback?: (editor: Editor, ctx?: unknown) => void;
          editorCheckCallback?: (
            checking: boolean,
            editor: Editor,
            ctx?: unknown,
          ) => boolean | void;
        }
      | undefined;

    if (!command) return false;

    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    const file = view?.file;

    if (editor && typeof command.editorCheckCallback === "function") {
      const ok = command.editorCheckCallback(true, editor, file);
      if (ok === false) return false;
      command.editorCheckCallback(false, editor, file);
      return true;
    }

    if (editor && typeof command.editorCallback === "function") {
      command.editorCallback(editor, file);
      return true;
    }

    if (typeof command.checkCallback === "function") {
      const ok = command.checkCallback(true);
      if (ok === false) return false;
      command.checkCallback(false);
      return true;
    }

    if (typeof command.callback === "function") {
      command.callback();
      return true;
    }

    return false;
  }

  isCommandExecutable(commandId: string): boolean {
    const command = this.deps.obsidianCommands.commands[commandId] as
      | {
          callback?: () => void;
          checkCallback?: (checking: boolean) => boolean | void;
          editorCallback?: (editor: Editor, ctx?: unknown) => void;
          editorCheckCallback?: (
            checking: boolean,
            editor: Editor,
            ctx?: unknown,
          ) => boolean | void;
        }
      | undefined;

    if (!command) return false;

    return (
      typeof command.callback === "function" ||
      typeof command.checkCallback === "function" ||
      typeof command.editorCallback === "function" ||
      typeof command.editorCheckCallback === "function"
    );
  }
}
