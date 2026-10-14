import { FileSystemAdapter, Notice, Platform } from "obsidian";
import { openSystemPath } from "src/core/external-open";
import { PLUGIN_MODE, PluginModes } from "src/core/types";
import type OnDemandPlugin from "src/main";
import { addModeOptions, enabledBadgeText, getPluginStatistics, openBackupDirectory, openPluginDirectory, pluginManagementSummary, pluginModeLabel, pluginStatisticsText } from "src/ui/settings/helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/core/external-open", () => ({ openSystemPath: vi.fn() }));

const noticeMock = Notice as unknown as { messages: string[]; clearMessages: () => void };

function createPlugin(modes: Record<string, string> = {}) {
    return {
        manifests: Object.keys(modes).map((id) => ({ id })),
        getPluginMode: (id: string) => modes[id] ?? PLUGIN_MODE.LAZY,
    } as unknown as OnDemandPlugin;
}

function createAdapter() {
    return Object.assign(new FileSystemAdapter(), {
        exists: vi.fn().mockResolvedValue(true),
        mkdir: vi.fn().mockResolvedValue(undefined),
    });
}

describe("settings helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        noticeMock.clearMessages();
        Platform.isDesktopApp = false;
    });

    it("counts every plugin mode and formats the settings summaries", () => {
        const plugin = createPlugin({
            enabled: PLUGIN_MODE.ALWAYS_ENABLED,
            disabled: PLUGIN_MODE.ALWAYS_DISABLED,
            lazy: PLUGIN_MODE.LAZY,
            layout: PLUGIN_MODE.LAZY_ON_LAYOUT_READY,
        });

        expect(getPluginStatistics(plugin)).toEqual({ alwaysEnabled: 1, alwaysDisabled: 1, lazy: 1, lazyOnLayoutReady: 1, total: 4 });
        expect(pluginStatisticsText(plugin)).toBe("⛔ 1 · 🤲 1 · 🚀 1 · ✅ 1");
        expect(pluginManagementSummary(plugin)).toBe("4 plugins");
        expect(pluginModeLabel(PLUGIN_MODE.LAZY)).toBe(PluginModes[PLUGIN_MODE.LAZY]);
    });

    it("distinguishes unloaded plugins from runtime-only plugins", () => {
        const app = { plugins: { plugins: { loaded: { _loaded: true }, runtime: { _loaded: true } } } };

        expect(enabledBadgeText(app as never, "missing")).toBe("Not loaded");
        expect(enabledBadgeText(app as never, "loaded", new Set(["loaded"]))).toBe("Loaded");
        expect(enabledBadgeText(app as never, "runtime", new Set())).toBe("Loaded (in memory only)");
    });

    it("reports why plugin folders cannot be opened outside desktop or without a path", async () => {
        const app = { vault: { adapter: createAdapter() } };

        await openPluginDirectory(app as never, { name: "Sample", dir: "plugins/sample" });
        expect(noticeMock.messages.at(-1)).toContain("desktop only");

        Platform.isDesktopApp = true;
        await openPluginDirectory({ vault: { adapter: {} } } as never, { name: "Sample", dir: "plugins/sample" });
        expect(noticeMock.messages.at(-1)).toContain("desktop only");

        await openPluginDirectory(app as never, { name: "Sample" });
        expect(noticeMock.messages.at(-1)).toContain("Could not locate");
    });

    it("opens a plugin folder and reports returned or thrown errors", async () => {
        Platform.isDesktopApp = true;
        const app = { vault: { adapter: createAdapter() } };
        vi.mocked(openSystemPath).mockResolvedValueOnce("").mockResolvedValueOnce("denied").mockRejectedValueOnce(new Error("shell failed"));

        await openPluginDirectory(app as never, { name: "Sample", dir: "plugins/sample" });
        expect(openSystemPath).toHaveBeenNthCalledWith(1, "vault/plugins/sample");
        await openPluginDirectory(app as never, { name: "Sample", dir: "plugins/sample" });
        expect(noticeMock.messages.at(-1)).toContain("denied");
        await openPluginDirectory(app as never, { name: "Sample", dir: "plugins/sample" });
        expect(noticeMock.messages.at(-1)).toContain("shell failed");
    });

    it("creates and opens a backup directory when needed", async () => {
        Platform.isDesktopApp = true;
        const adapter = createAdapter();
        adapter.exists.mockResolvedValue(false);
        const plugin = {
            app: { vault: { adapter } },
            manifest: { dir: "plugins/sample" },
        } as unknown as OnDemandPlugin;
        vi.mocked(openSystemPath).mockResolvedValue("");

        await openBackupDirectory(plugin);

        expect(adapter.mkdir.mock.calls).toContainEqual(["plugins/sample/backups"]);
        expect(openSystemPath).toHaveBeenCalledWith("vault/plugins/sample/backups");
    });

    it("reports backup folder errors and keeps mobile access guarded", async () => {
        const adapter = createAdapter();
        const plugin = {
            app: { vault: { adapter } },
            manifest: { dir: "plugins/sample" },
        } as unknown as OnDemandPlugin;

        await openBackupDirectory(plugin);
        expect(noticeMock.messages.at(-1)).toContain("desktop only");

        Platform.isDesktopApp = true;
        adapter.exists.mockRejectedValueOnce(new Error("adapter failed"));
        await openBackupDirectory(plugin);
        expect(noticeMock.messages.at(-1)).toContain("adapter failed");

        adapter.exists.mockResolvedValue(true);
        vi.mocked(openSystemPath).mockResolvedValueOnce("denied");
        await openBackupDirectory(plugin);
        expect(noticeMock.messages.at(-1)).toContain("denied");
    });

    it("adds the complete mode list to a dropdown and returns it", () => {
        const dropdown = { addOption: vi.fn() };

        expect(addModeOptions(dropdown as never)).toBe(dropdown);
        expect(dropdown.addOption).toHaveBeenCalledTimes(Object.keys(PluginModes).length);
        expect(dropdown.addOption).toHaveBeenCalledWith(PLUGIN_MODE.ALWAYS_ENABLED, PluginModes[PLUGIN_MODE.ALWAYS_ENABLED]);
    });
});
