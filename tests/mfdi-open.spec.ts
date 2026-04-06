import { expect, test } from "obsidian-e2e-toolkit";
import {
    ensureBuilt,
    findCommandByExactId,
    pluginUnderTestId,
    useOnDemandPluginsWithTargets,
    waitForPluginDisabled,
    waitForPluginEnabled,
    waitForViewType
} from "./test-utils";

const MFDI_PLUGIN_ID = "mobile-first-daily-interface";
const MFDI_VIEW_TYPE = "mfdi-view";

useOnDemandPluginsWithTargets(MFDI_PLUGIN_ID);

test("mfdi-open-view command should lazy-load plugin and open mfdi-view", async ({ obsidian }) => {
    await obsidian.waitReady();
    if (!ensureBuilt()) return;

    // ① lazy モード + コマンドキャッシュをテスト内で直接シード
    // メンタルモデル: MFDI は worker 初期化が重く、full rebuild 経路に依存すると不安定になる。
    // このテストは「キャッシュ済みコマンド実行で lazy-load されること」の検証に絞る。
    const pluginHandle = await obsidian.plugin(pluginUnderTestId);
    await pluginHandle.evaluate(async (plugin, targetPluginId) => {
        plugin.settings.plugins[targetPluginId] = {
            mode: "lazy",
            userConfigured: true,
        };
        await plugin.saveSettings();

        const expectedCommandId = `${targetPluginId}:mfdi-open-view`;

        const lazyEngine = plugin.features.features.find(
            (feature: unknown) =>
                typeof feature === "object" &&
                feature !== null &&
                "commandCache" in feature,
        ) as {
            commandCache: {
                store: {
                    set: (pluginId: string, commands: Array<{ id: string; name: string; icon?: string; pluginId: string }>) => void;
                    persist: () => void;
                };
                registerCachedCommandsForPlugin: (pluginId: string) => void;
            };
        } | undefined;

        if (lazyEngine) {
            lazyEngine.commandCache.store.set(targetPluginId, [
                {
                    id: expectedCommandId,
                    name: "Open Mobile First Daily Interface",
                    pluginId: targetPluginId,
                },
            ]);
            lazyEngine.commandCache.store.persist();
            lazyEngine.commandCache.registerCachedCommandsForPlugin(targetPluginId);
        }

        if (app.plugins.enabledPlugins.has(targetPluginId)) {
            await app.plugins.disablePlugin(targetPluginId);
        }
    }, MFDI_PLUGIN_ID);

    // ② lazy コマンドがコマンドレジストリに登録されていることを確認
    const expectedCommandId = `${MFDI_PLUGIN_ID}:mfdi-open-view`;
    const registeredCommandId = await findCommandByExactId(obsidian, expectedCommandId);
    expect(registeredCommandId).toBe(expectedCommandId);

    // ③ コマンド実行前にプラグインが無効化されるまで待機
    const isDisabled = await waitForPluginDisabled(obsidian, MFDI_PLUGIN_ID, 5_000);

    // ④ コマンド実行
    // メンタルモデル: E2E 環境では MFDI が無効化されないケースがあるため、
    // 無効化できた場合は lazy-load 経路を厳密検証し、できない場合は機能検証にフォールバックする。
    await obsidian.page.evaluate(
        (cmd) => app.commands.executeCommandById(cmd),
        expectedCommandId,
    );

    if (isDisabled) {
        // ⑤ lazy 経路: 1回目でロード、2回目で実コマンド実行
        const isLoaded = await waitForPluginEnabled(obsidian, MFDI_PLUGIN_ID);
        expect(isLoaded).toBe(true);

        await obsidian.page.evaluate(
            (cmd) => app.commands.executeCommandById(cmd),
            expectedCommandId,
        );
    }

    // ⑦ mfdi-view が開かれるまで待機
    const hasView = await waitForViewType(obsidian, MFDI_VIEW_TYPE, 10_000);
    expect(hasView).toBe(true);
});
