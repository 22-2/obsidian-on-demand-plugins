import { WorkspaceLeaf } from "obsidian";
import { KeyedMutex } from "keyed-mutex";

/**
 * Generic lock strategy interface for async mutual exclusion
 */
export interface LockStrategy<T> {
    lock(target: T): Promise<LockRelease>;
}

export interface LockRelease {
    unlock(): void;
}

/**
 * Lock strategy specifically for WorkspaceLeaf and viewType combinations.
 * Ensures that lazy loading for the same leaf+viewType combination is serialized.
 */
export class LeafViewLockStrategy implements LockStrategy<{ leaf: WorkspaceLeaf; viewType: string }> {
    private keyedMutex = new KeyedMutex<string>();
    private leafIds = new WeakMap<WorkspaceLeaf, string>();
    private nextLeafId = 1;

    async lock(target: { leaf: WorkspaceLeaf; viewType: string }): Promise<LockRelease> {
        const key = this.keyFor(target.leaf, target.viewType);
        return await this.keyedMutex.lock(key);
    }

    private keyFor(leaf: WorkspaceLeaf, viewType: string): string {
        let id = this.leafIds.get(leaf);
        if (!id) {
            id = String(this.nextLeafId++);
            this.leafIds.set(leaf, id);
        }
        return `leaf:${id}:view:${viewType}`;
    }
}

/**
 * No-op lock strategy for testing or scenarios where locking is not needed
 */
export class NoOpLockStrategy<T> implements LockStrategy<T> {
    async lock(_target: T): Promise<LockRelease> {
        return {
            unlock: () => {
                // No-op
            },
        };
    }
}
