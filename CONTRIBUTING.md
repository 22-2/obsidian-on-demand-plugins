# Contributing

## Reporting issues

Open an issue using one of the templates under [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE/). Please include your Obsidian version, the plugin version, and steps to reproduce.

## Development setup

The plugin needs to live inside a real Obsidian vault to test against the API. Clone it directly into a test vault:

```bash
cd /path/to/test-vault/.obsidian/plugins
git clone https://github.com/alangrainger/obsidian-lazy-plugins.git lazy-plugins
cd lazy-plugins
npm install
npm run dev
```

`npm run dev` runs esbuild in watch mode. Reload Obsidian (Ctrl+R / Cmd+R) to pick up changes, or install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin to do it automatically.

## Building

```bash
npm run build
```

This runs `tsc` for type checking and bundles via esbuild. The build must be green before merging.

## Pull requests

- Branch off `main` and open the PR against `main`.
- Keep changes focused. Small, single-purpose PRs are easier to review.
- If you're fixing a bug, please reference the issue in the PR description.

## Release process

Releases are cut by the maintainer. The workflow at `.github/workflows/release.yml` builds, attests provenance, and creates a draft GitHub release whenever a version tag is pushed.
