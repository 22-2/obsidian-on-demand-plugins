export default {
    git: {
        requireBranch: "main",
        requireCleanWorkingDir: true,
        requireCommits: true,
        addUntrackedFiles: false,
        tagName: "${version}",
        tagMatch: "[0-9]*.[0-9]*.[0-9]*",
        commitMessage: "chore(release): ${version} [skip ci]\n\n${changelog}",
        // Push only main and the new release tag in after:release to avoid sending unrelated tags.
        push: false,
    },
    npm: { publish: false },
    // Manage versions locally; GitHub Actions builds and publishes the release assets.
    github: { release: false },
    plugins: {
        "@release-it/bumper": { out: "manifest.json" },
        "@release-it/conventional-changelog": {
            infile: "CHANGELOG.md",
            preset: {
                name: "conventionalcommits",
                types: [
                    { type: "feat", section: "✨ Features" },
                    { type: "style", section: "🎨 Styles" },
                    { type: "fix", section: "🛡 Bug Fixes" },
                    { type: "build", section: "🤖 Build" },
                    { type: "docs", effect: "hidden" },
                    { type: "refactor", effect: "hidden" },
                    { type: "test", effect: "hidden" },
                    { type: "ci", effect: "hidden" },
                    { type: "dev", effect: "hidden" },
                    { type: "chore", effect: "hidden" },
                ],
            },
            // Preserve the existing bump rules during migration, including minor bumps for style/build.
            whatBump(commits) {
                let level;
                for (const commit of commits) {
                    if (commit.notes?.length) return { level: 0, reason: "Breaking changes" };
                    if (["feat", "style", "build"].includes(commit.type)) level = 1;
                    else if (level === undefined && (["fix", "refactor", "revert"].includes(commit.type) || commit.revert || (commit.type === "chore" && commit.scope === "release"))) level = 2;
                }
                return { level, reason: "Existing release rules" };
            },
        },
    },
    hooks: {
        "before:init": ["gh auth status", "pnpm run lint", "pnpm test --run"],
        "before:release": "pnpm run typecheck",
        "after:release": ["git push --atomic origin HEAD:refs/heads/main refs/tags/${version}:refs/tags/${version}", "gh workflow run release.yml --repo 22-2/obsidian-on-demand-plugins --ref main --field version=${version}"],
    },
};
