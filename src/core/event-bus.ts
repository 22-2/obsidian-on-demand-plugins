export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Simple, type-safe EventBus for inter-feature communication.
 * Features can emit events without knowing which other features are listening.
 */
export class EventBus {
    private handlers = new Map<string, Set<EventHandler>>();

    /**
     * Subscribe to an event.
     */
    on<T = unknown>(event: string, handler: EventHandler<T>): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
    }

    /**
     * Unsubscribe from an event.
     */
    off<T = unknown>(event: string, handler: EventHandler<T>): void {
        this.handlers.get(event)?.delete(handler);
    }

    /**
     * Emit an event and wait for all handlers to complete.
     */
    async emit<T = unknown>(event: string, payload: T): Promise<void> {
        const set = this.handlers.get(event);
        if (!set) return;

        const promises: Promise<void>[] = [];
        for (const handler of set) {
            try {
                const result = handler(payload);
                if (result instanceof Promise) {
                    promises.push(result);
                }
            } catch (error) {
                console.error(`[EventBus] Error in handler for event "${event}":`, error);
            }
        }
        await Promise.all(promises);
    }

    /**
     * Clear all handlers (useful for cleanup).
     */
    clear(): void {
        this.handlers.clear();
    }
}

/**
 * Define common event names as constants to avoid typos.
 */
export const FeatureEvents = {
    /** Request to rebuild the command cache and apply policies. Payload: { force?: boolean } */
    REBUILD_CACHE_REQUESTED: "lazy-engine:rebuild-cache-requested",
    /** Request to apply startup policies and restart. Payload: { pluginIds?: string[] } */
    APPLY_POLICIES_REQUESTED: "lazy-engine:apply-policies-requested",
} as const;
