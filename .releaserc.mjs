export default {
    repositoryUrl: "https://github.com/22-2/obsidian-on-demand-plugins.git",
    branches: ["main"],
    tagFormat: "${version}",
    plugins: [
        [
            "@semantic-release/commit-analyzer",
            {
                preset: "conventionalcommits",
                releaseRules: [
                    { breaking: true, release: "major" },
                    { type: "feat", release: "minor" },
                    { type: "build", release: "minor" },
                    { type: "style", release: "minor" },
                    { type: "fix", release: "patch" },
                    { type: "refactor", release: "patch" },
                    {type: "chore", scope: "release", release: "patch"},
                    { revert: true, release: "patch" },
                ],
            },
        ],
        [
            "@semantic-release/release-notes-generator",
            {
                preset: "conventionalcommits",
                presetConfig: {
                    types: [
                        { type: "feat", section: "✨ Features" },
                        { type: "style", section: "🎨 Styles" },
                        { type: "fix", section: "🛡 Bug Fixes" },
                        { type: "build", section: "🤖 Build" },
                        { type: "docs", hidden: true },
                        { type: "refactor", hidden: true },
                        { type: "test", hidden: true },
                        { type: "ci", hidden: true },
                        { type: "dev", hidden: true },
                        { type: "chore", hidden: true },
                    ],
                },
            },
        ],
        [
            "@semantic-release/exec",
            {
                // Node.js の型除去で直接実行し、dlx の一時環境で esbuild のビルド承認が必要になるのを避ける。
                prepareCmd: "pnpm exec node version-bump.mts ${nextRelease.version}",
            },
        ],
        [
            "@semantic-release/github",
            {
                assets: ["main.js", "styles.css", "manifest.json"],
            },
        ],
        [
            "@semantic-release/git",
            {
                // リリース時に実際に更新されるファイルだけをコミットする。
                assets: ["package.json", "manifest.json", "versions.json"],
                message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
            },
        ],
    ],
};
