// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    ...obsidianmd.configs.recommended,
    // Or include English locale files (JSON and TS/JS modules)
    // ...obsidianmd.configs.recommendedWithLocalesEn,

    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: { project: "./tsconfig.json" },
        },

        // Optional project overrides
        rules: {
            "obsidianmd/ui/sentence-case": [
                "warn",
                {
                    brands: ["YourBrand"],
                    acronyms: ["OK"],
                    enforceCamelCaseLower: true,
                },
            ],
        },
    },
]);
