import path from "node:path";
import { expect, test } from "obsidian-e2e-toolkit";
import { ensureBuilt, pluginUnderTestId, repoRoot } from "./test-utils";

const MFDI_PLUGIN_ID = "mobile-first-daily-interface";
const MFDI_VIEW_TYPE = "mfdi-view";
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10_000;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function useMFDIPlugin() {
    test.use({
        vaultOptions: {
            logLevel: "info",
            enableBrowserConsoleLogging: true,
            fresh: true,
            plugins: [
                { path: repoRoot },
                { path: path.resolve(repoRoot, "myfiles", MFDI_PLUGIN_ID) },
            ],
        },
    });
}

/** Condition が true になるまで最大 timeoutMs ミリ秒ポーリングする。タイムアウト時は false を返す。 */
async function pollUntil(
    condition: () => Promise<boolean>,
    timeoutMs = POLL_TIMEOUT_MS,
    intervalMs = POLL_INTERVAL_MS,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

// ──────────────────────────────────────────────
// Test setup
// ──────────────────────────────────────────────

useMFDIPlugin();

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

test("mfdi-open-view command should lazy-load plugin and open mfdi-view", async ({ obsidian }) => {
    await obsidian.waitReady();
    if (!ensureBuilt()) return;

    // ① lazy モードに切り替えてコマンドキャッシュを再構築
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, targetPluginId) => {
        // "app:reload" をインターセプトしてテスト中にリロードが走らないようにする
        const originalExec = app.commands.executeCommandById.bind(app.commands);
        app.commands.executeCommandById = (id: string) =>
            id === "app:reload" ? true : originalExec(id);

        try {
            await plugin.updatePluginSettings(targetPluginId, "lazy");
            await plugin.rebuildAndApplyCommandCache({ force: true });
        } finally {
            app.commands.executeCommandById = originalExec;
        }
    }, MFDI_PLUGIN_ID);

    // ② lazy コマンドがコマンドレジストリに登録されていることを確認
    const expectedCommandId = `${MFDI_PLUGIN_ID}:mfdi-open-view`;
    const registeredCommandId = await obsidian.page.evaluate(
        (id) => Object.keys(app.commands.commands).find((cmd) => cmd === id) ?? null,
        expectedCommandId,
    );
    expect(registeredCommandId).toBe(expectedCommandId);

    // ③ コマンド実行前はプラグインが無効であることを確認
    expect(await obsidian.isPluginEnabled(MFDI_PLUGIN_ID)).toBe(false);

    // ④ 1回目の実行: lazy ローダーラッパーに消費される
    await obsidian.page.evaluate(
        (cmd) => app.commands.executeCommandById(cmd),
        expectedCommandId,
    );

    // ⑤ プラグインがロードされるまで待機
    const isLoaded = await pollUntil(() => obsidian.isPluginEnabled(MFDI_PLUGIN_ID));
    expect(isLoaded).toBe(true);

    // ⑥ 2回目の実行: 実際のプラグインコマンドが走り、ビューが開く
    await obsidian.page.evaluate(
        (cmd) => app.commands.executeCommandById(cmd),
        expectedCommandId,
    );

    // ⑦ mfdi-view が開かれるまで待機
    const hasView = await pollUntil(() =>
        obsidian.page.evaluate(
            (type) => app.workspace.getLeavesOfType(type).length > 0,
            MFDI_VIEW_TYPE,
        ),
    );
    expect(hasView).toBe(true);
});
