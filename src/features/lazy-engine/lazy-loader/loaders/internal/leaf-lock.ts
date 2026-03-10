import { Mutex } from "async-mutex";
import type { WorkspaceLeaf } from "obsidian";

/**
 * Generic lock strategy interface for async mutual exclusion.
 * Implementations provide different locking strategies for different use cases.
 */
export interface LockStrategy<T> {
    /**
     * Acquires a lock for the given target.
     * @param target - The target to lock
     * @returns A promise that resolves to a lock release handle
     */
    lock(target: T): Promise<LockRelease>;
}

/**
 * Handle for releasing an acquired lock.
 */
interface LockRelease {
    /**
     * Releases the lock. Should be called in a finally block to ensure cleanup.
     */
    unlock(): void;
}

/**
 * Centralized lock manager that uses WeakMap to associate Mutexes with WorkspaceLeafs.
 * This ensures that when a leaf is destroyed/GC'd, its associated Mutexes are also collected.
 *
 * The manager supports sub-keys to allow different types of locks on the same leaf
 * (e.g., view-specific locks vs. generic leaf locks).
 */
export class LeafLockManager {
    private leafMutexes = new WeakMap<WorkspaceLeaf, Map<string, Mutex>>();

    /**
     * Acquires a lock for a specific leaf, optionally specialized by a sub-key.
     *
     * @param leaf - The workspace leaf to lock
     * @param subKey - Optional sub-key to differentiate lock types (default: "default")
     * @returns A promise that resolves to a lock release handle
     */
    async lock(leaf: WorkspaceLeaf, subKey: string = "default"): Promise<LockRelease> {
        let subMap = this.leafMutexes.get(leaf);
        if (!subMap) {
            subMap = new Map<string, Mutex>();
            this.leafMutexes.set(leaf, subMap);
        }

        let mutex = subMap.get(subKey);
        if (!mutex) {
            mutex = new Mutex();
            subMap.set(subKey, mutex);
        }

        const release = await mutex.acquire();
        return {
            unlock: () => {
                release();
            },
        };
    }
}

/**
 * Specialized strategy for locking a leaf based on its viewType.
 * Used by ViewLazyLoader to prevent concurrent processing of the same view type.
 */
export class LeafViewLockStrategy implements LockStrategy<LeafResource> {
    constructor(private manager: LeafLockManager) {}

    async lock(target: LeafResource): Promise<LockRelease> {
        return this.manager.lock(target.leaf, `view:${target.viewType}`);
    }
}

export type LeafResource = { leaf: WorkspaceLeaf; viewType: string };
