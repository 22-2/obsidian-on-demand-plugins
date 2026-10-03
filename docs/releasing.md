# Releasing

[Japanese](releasing_jp.md)

`release-it` updates versions locally. GitHub Actions builds and publishes the assets from the release tag.
Check authentication with `gh auth status`, commit your changes, and run the release from `main`.
The real release command runs lint, unit tests, and type checks before releasing.

```powershell
pnpm release:dry
pnpm release
```

The next version is normally suggested from commits. To choose a version explicitly, use a command such as `pnpm release 3.6.2`.
The release updates the versions in `package.json` and `manifest.json`, along with `CHANGELOG.md`. Tags have no `v` prefix.
Only `main` and the new release tag are pushed. Check the Release workflow in Actions to confirm publication.

## Updating the compatibility map

Normal releases leave `versions.json` unchanged. When you need to record the minimum supported Obsidian version,
set `manifest.minAppVersion` and use these commands:

```powershell
pnpm release:with-versions --dry-run --ci
pnpm release:with-versions
```

## Rerunning publication

If the tag was already created but publication failed, dispatch the workflow for that existing tag:

```powershell
gh workflow run release.yml --repo 22-2/obsidian-on-demand-plugins --ref main --field version=3.6.2
```

The workflow checks out the specified tag, builds the assets, verifies their versions, and publishes the release.
To check release assets locally, run `pnpm build` followed by `pnpm verify-build`.
