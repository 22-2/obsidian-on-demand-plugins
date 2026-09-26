import type { PluginManifest } from "obsidian";
import { getToggleTargets } from "src/features/manual-toggle/manual-toggle-feature";
import { formatPluginChoice } from "src/ui/modals/plugin-picker-modal";
import { describe, expect, it } from "vitest";

function manifest(id: string, name: string): PluginManifest {
    return { id, name, author: "author-of-" + id } as PluginManifest;
}

describe("formatPluginChoice", () => {
    it("formats as NAME (id - author)", () => {
        expect(formatPluginChoice(manifest("my-id", "My Plugin"))).toBe("My Plugin (my-id - author-of-my-id)");
    });
});

describe("getToggleTargets", () => {
    const manifests = [manifest("b-id", "B Plugin"), manifest("a-id", "A Plugin"), manifest("c-id", "C Plugin")];
    const isLoaded = (loadedIds: string[]) => (id: string) => loadedIds.includes(id);

    it("returns unloaded plugins sorted by name for the enable picker", () => {
        expect(getToggleTargets(manifests, isLoaded(["b-id"]), false).map((m) => m.id)).toEqual(["a-id", "c-id"]);
    });

    it("returns loaded plugins sorted by name for the disable picker", () => {
        expect(getToggleTargets(manifests, isLoaded(["c-id", "b-id"]), true).map((m) => m.id)).toEqual(["b-id", "c-id"]);
    });
});
