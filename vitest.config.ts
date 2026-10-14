import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: "vitest.setup.ts",
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "scripts/*.test.js"],
        exclude: ["node_modules", "dist", ".obsidian", "tests"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.test.ts", "src/**/__mocks__/**", "src/**/*.d.ts"],
            reportsDirectory: "coverage/unit",
            reporter: ["text", "html", "lcov", "json"],
        },
    },
    resolve: {
        alias: {
            src: path.resolve(__dirname, "./src"),
            "obsidian": path.resolve(__dirname, "./src/__mocks__/obsidian.ts"),
        }
    }
});
