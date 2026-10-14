import type { WorkspaceLeaf } from "obsidian";
import { LeafLockManager, LeafViewLockStrategy } from "src/features/lazy-engine/lazy-loader/loaders/internal/leaf-lock";
import { describe, expect, it } from "vitest";

function createLeaf(): WorkspaceLeaf {
    return {} as WorkspaceLeaf;
}

describe("LeafLockManager", () => {
    it("serializes acquisitions for the same leaf and key", async () => {
        const manager = new LeafLockManager();
        const leaf = createLeaf();
        const first = await manager.lock(leaf);
        let secondAcquired = false;
        const secondPromise = manager.lock(leaf).then((release) => {
            secondAcquired = true;
            return release;
        });

        await Promise.resolve();
        expect(secondAcquired).toBe(false);

        first.unlock();
        const second = await secondPromise;
        expect(secondAcquired).toBe(true);
        second.unlock();
    });

    it("allows different leaves and subkeys to proceed independently", async () => {
        const manager = new LeafLockManager();
        const leaf = createLeaf();
        const otherLeaf = createLeaf();
        const defaultLock = await manager.lock(leaf);
        const viewLock = await manager.lock(leaf, "view:canvas");
        const otherLeafLock = await manager.lock(otherLeaf);

        defaultLock.unlock();
        viewLock.unlock();
        otherLeafLock.unlock();
    });

    it("uses the view type as the lock subkey", async () => {
        const manager = new LeafLockManager();
        const strategy = new LeafViewLockStrategy(manager);
        const leaf = createLeaf();
        const firstViewLock = await strategy.lock({ leaf, viewType: "canvas" });
        let sameViewAcquired = false;
        let otherViewAcquired = false;
        const sameViewPromise = strategy.lock({ leaf, viewType: "canvas" }).then((release) => {
            sameViewAcquired = true;
            return release;
        });
        const otherViewPromise = strategy.lock({ leaf, viewType: "markdown" }).then((release) => {
            otherViewAcquired = true;
            return release;
        });

        const otherViewLock = await otherViewPromise;
        expect(sameViewAcquired).toBe(false);
        expect(otherViewAcquired).toBe(true);

        firstViewLock.unlock();
        const sameViewLock = await sameViewPromise;
        otherViewLock.unlock();
        sameViewLock.unlock();
    });
});
