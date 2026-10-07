# リリース手順

[English](releasing.md)

`release-it` がローカルで版を更新し、GitHub Actions がそのタグの配布物をビルド・公開します。
`gh auth status` で認証済みであることを確認し、変更をコミットして `main` から実行してください。
本番のコマンドでは lint・ユニットテスト・型チェックを実行してからリリースします。

```powershell
pnpm release:dry
pnpm release
```

通常はコミットから版を提案します。明示する場合は `pnpm release 3.6.2` のように指定できます。
`package.json` と `manifest.json` の版、`CHANGELOG.md` を更新します。タグ名には `v` を付けません。
push するのは `main` と今回作成したタグだけです。公開完了は Actions の Release ワークフローで確認できます。

## 互換性マップも更新する場合

`versions.json` は通常のリリースでは変更しません。Obsidian の最低対応版を記録する必要がある場合は、
`manifest.minAppVersion` を設定して次のコマンドを使ってください。

```powershell
pnpm release:with-versions --dry-run --ci
pnpm release:with-versions
```

## 公開ワークフローを再実行する場合

タグが作成済みで公開だけ失敗した場合は、バージョンを再更新せずに既存タグを指定します。

```powershell
gh workflow run release.yml --repo 22-2/obsidian-on-demand-plugins --ref main --field version=3.6.2
```

ワークフローは入力したタグをチェックアウトし、ビルド・配布ファイルの版確認後に公開します。
ローカルで配布物を確認するときは `pnpm build` と `pnpm verify-build` を実行してください。
