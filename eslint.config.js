// @ts-check
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig } from "eslint/config"

export default defineConfig([
    // @ts-expect-error
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["src/**/*.test.ts"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            "@typescript-eslint/await-thenable": "off",
            "@typescript-eslint/no-misused-promises": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/unbound-method": "off",
        },
    },
    {
        files: ["*.config.ts", "*.config.js"],
        rules: {
            "import/no-nodejs-modules": "off",
            "obsidianmd/hardcoded-config-path": "off",
        },
    },
    {
        ignores: [
            "**/*.{js,json}",
            "content.txt",
            "myfiles/**/*",
            "playwright-report/**/*",
            "test-results/**/*",
            "tests/**/*",
        ]
    },
]);
