import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["node_modules", "dist", ".obsidian", "tests"],
    },
    resolve: {
        alias: {
            obsidian: "./src/__mocks__/obsidian.ts"
        }
    }
});
