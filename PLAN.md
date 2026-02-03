# Apply Changes 改善（将来課題） 実装プラン

## 目的
- Apply Changes 実行時の「ロード→即アンロード」起因の不安定さ・エラーを抑止する。
- 一括ロード方式でコマンド/ビュー登録を安定させ、キャッシュ取得と設定反映を安全に行う。

## 現状の問題点
- 逐次 `applyPluginState()` が `lazy` / `lazyWithView` を即アンロードするため、コマンド/ビュー登録の途中で破棄される。
- `community-plugins.json` の状態と実行時のロード状態が短時間で入れ替わり、副作用が出やすい。

## 目標アーキテクチャ（概要）
1. 一括ロード（設定保存なし）
2. 全プラグインの `_loaded` が true になるまで待機
3. 追加の安定化待機（数秒）
4. コマンドキャッシュ再構築
5. `community-plugins.json` を KeepEnabled のみで上書き
6. Obsidian 再起動（失敗時は手動案内）

## 変更対象ファイル
- src/services/startup-policy-service.ts
- src/main.ts
- src/settings.ts
- src/progress.ts（必要ならキャンセル対応強化）

## 実装方針（詳細）
### 1) 一括ロード実行（設定保存なし）
- `obsidianPlugins.enablePlugin(pluginId)` を順次実行。
- `enablePluginAndSave()` は使用しない。

### 2) ロード完了待機
- `obsidianPlugins.plugins[pluginId]?._loaded` をポーリングで監視。
- 全件 true になったら追加待機（例: 2–5 秒）。

### 3) コマンドキャッシュ再構築
- `CommandCacheService.refreshCommandCache()` を実行。

### 4) KeepEnabled のみ保存
- `PluginMode === "keepEnabled"` と `lazyPluginId` のみで
  `community-plugins.json` を上書き。

### 5) 再起動
- 可能なら `app.commands.executeCommandById("app:reload")` を実行。
- 失敗時は Notice で手動再起動を案内。

## UI/UX 設計
- 既存方式の「Apply changes」を完全に置き換える。
- ProgressDialog を使用し、キャンセル可能にする（中断時は安全に終了）。
- 「安全に終了」の方法は、ロード済みプラグインをそのままにし、KeepEnabled のみ保存して再起動を促す。

## 新規/追加メソッド案
### StartupPolicyService
- `apply(showProgress = false)`
  - 一括ロード方式の実装本体。
- `waitForAllPluginsLoaded(pluginIds, timeoutMs)`
  - `_loaded` 監視とタイムアウト。

### LazyPlugin
- `applyStartupPolicyBulk(showProgress = false)`
  - `StartupPolicyService.apply()` への薄いラッパー。

## 進捗表示
- ProgressDialog に以下を表示:
  - ロード中のプラグイン名
  - ロード進捗
  - 待機フェーズ（「Waiting for plugins to finish registering…」など）

## 失敗時の挙動
- 一括ロード中に失敗したプラグインはログ出力し続行。
- 最終的に KeepEnabled のみ保存し再起動でリセット。

## 受け入れ条件
- Apply Bulk 実行後、エラーが大幅に減る。
- コマンドキャッシュが安定して構築される。
- `community-plugins.json` が KeepEnabled のみになる。
- 再起動後、KeepEnabled 以外は自動でロードされない。
