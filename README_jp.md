# On-Demand Plugins

Obsidian プラグインの起動を遅延させ、必要なときだけ読み込むことで、起動速度を向上させるプラグインです。

---

## 使い方

1. **設定 → On-Demand Plugins** を開く
2. 各プラグインの読み込みモードを選択する
3. **Apply changes** をクリックする（Obsidian が自動的に再起動されます）

---

## 読み込みモード

| モード                   | 説明                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| **Lazy on demand**       | コマンド実行・指定ビューを開いたとき・特定ファイルを開いたときに読み込む |
| **Lazy on layout ready** | レイアウト準備完了後に読み込む                                           |
| **Always enabled**       | 起動時に通常通り読み込む                                                 |
| **Always disabled**      | 常に無効のままにする                                                     |

> **Lazy on demand** を選択した場合、設定モーダルで `lazy on file` と `lazy on view` を個別に指定できます。ビュータイプは Apply changes 時に自動取得されるため、手動入力は不要です。

---

## 注意事項

**`setInterval` / `setTimeout` やグローバルイベントフック（`vault.on` など）を使うプラグイン**は、**Lazy on layout ready** に設定してください。**Lazy on demand** にするとトリガーされるまで有効化されず、バックグラウンド処理が動作しない場合があります。

また、Dataview のようなインラインビューには対応していません。

---

## バックアップについて

設定変更時、`.obsidian/community-plugins.json` が自動的に書き換えられます。変更のたびに最大 3 世代のバックアップが自動作成されますが、念のためご自身でもバックアップを取ることを推奨します。

`community-plugins.json` が On-Demand Plugins 以外（Sync、Git、手動編集、Obsidian CLI、他のプラグインなど）で書き換えられた場合は、起動時に通知が表示され、変更を適用する前に上書きしてよいか確認されます。外部の変更を残したい場合は **Maintenance › Sync settings** で On-Demand の設定に取り込んでください。**Plugin data → Obsidian config** の方向で同期するときは、変更内容を表示して確認したうえで、反映のために Obsidian を再起動します。

この端末に入っていないプラグインや、モバイルでのデスクトップ専用プラグインのエントリはそのまま残します。Sync で `community-plugins.json` を共有していても、ほかの端末のプラグインが無効になることはありません。

## 保存していない変更について

モードの変更は **Review & save…** を押すまで下書きのままです。On-Demand の設定ページ間を移動しても下書きは残ります。設定画面を閉じたり別の設定タブに移ったりすると下書きは一時的に退避され、On-Demand は保存済みの設定で動きます。**Plugin management** または **Maintenance & batch** に戻ると、退避した下書きを戻すか（**Restore**）捨てるか（**Discard**）を聞かれます。**Plugin management › Unsaved draft prompt** で、自動で戻す・捨てるようにもできます。退避した下書きは Obsidian を再起動するまで保持されます。

---

## 仕組み

起動時にプラグイン本体を読み込む代わりに、コマンド情報をキャッシュした「ダミーコマンド」を登録します。実際にそのコマンドやビューが呼び出されたタイミングで、初めてプラグイン本体を読み込みます。内部的には Obsidian のコア機能をモンキーパッチして動作しているため、Obsidian のアップデートにより動作が不安定になる可能性があります。

---

*[Alan Grainger](https://github.com/alangrainger/obsidian-lazy-plugins) 氏のプロジェクトをベースに開発しました。*

## スクリーンショット

<!-- Screenshot: On-Demand Plugins settings -->
![On‑Demand Plugins settings](assets/ss.png)
*On‑Demand Plugins 設定ページのスクリーンショット.*

<!-- Screenshot: On-Demand Modal -->
![On‑Demand Modal](assets/ss-modal.png)
*設定モーダルのスクリーンショット.*

