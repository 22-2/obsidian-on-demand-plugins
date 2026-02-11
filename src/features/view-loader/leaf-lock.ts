import { WorkspaceLeaf } from "obsidian";
import { Mutex } from "async-mutex";

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
export interface LockRelease {
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
export class LeafViewLockStrategy implements LockStrategy<{ leaf: WorkspaceLeaf; viewType: string }> {
    constructor(private manager: LeafLockManager) {}

    async lock(target: { leaf: WorkspaceLeaf; viewType: string }): Promise<LockRelease> {
        return this.manager.lock(target.leaf, `view:${target.viewType}`);
    }
}

/**
 * Specialized strategy for locking a leaf regardless of its viewType.
 * Used by FileLazyLoader to prevent concurrent file-based processing on the same leaf.
 */
// NOTE: `LeafLockStrategy` adapter was removed to simplify the codebase.
// If an adapter is needed, callers can provide an object implementing
// `LockStrategy<WorkspaceLeaf>` that delegates to `LeafLockManager.lock(leaf, "leaf-generic")`.

// Default shared manager to ensure code that constructs loaders without
// explicitly providing a manager will still use a unified lock space.
export const defaultLeafLockManager = new LeafLockManager();


