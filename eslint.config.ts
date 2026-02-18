import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import pathPlugin from "eslint-plugin-path";
import { defineConfig } from "eslint/config";

export default defineConfig([
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        // @ts-expect-error
        plugins: { js, path: pathPlugin },
        extends: ["js/recommended"],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
        rules: {
            "path/no-relative-imports": "error",
            "@typescript-eslint/consistent-type-imports": [
                "error",
                {
                    prefer: "type-imports",
                    disallowTypeAnnotations: false,
                },
            ],
        },
    },
    tseslint.configs.recommended,
    prettier,
]);
