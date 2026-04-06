import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: "vitest.setup.ts",
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["node_modules", "dist", ".obsidian", "tests"],
    },
    resolve: {
        alias: {
            src: path.resolve(__dirname, "./src"),
            "obsidian": path.resolve(__dirname, "./src/__mocks__/obsidian.ts"),
        }
    }
});
