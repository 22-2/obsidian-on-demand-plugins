// @ts-check
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig } from "eslint/config"

export default defineConfig([
    // @ts-expect-error
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: {
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        ignores: ["**/*.{js,json}", "myfiles/**/*"]
    },
]);
