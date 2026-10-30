import log from "loglevel";

const logger = log.getLogger("OnDemandPlugin/EventBus");

/**
 * Event names, kept as constants to avoid typos.
 */
export const FeatureEvents = {
    /** Request to rebuild command/view caches and apply policies. */
    REBUILD_CACHE_REQUESTED: "lazy-engine:rebuild-cache-requested",
    /** Request to apply startup policies and restart. */
    APPLY_POLICIES_REQUESTED: "lazy-engine:apply-policies-requested",
} as const;

/**
 * Payload type for each event. Adding an event to `FeatureEvents` without an
 * entry here (or the reverse) is a compile error.
 */
export interface FeatureEventPayloads {
    [FeatureEvents.REBUILD_CACHE_REQUESTED]: { force?: boolean; externalChangesConfirmed?: boolean };
    [FeatureEvents.APPLY_POLICIES_REQUESTED]: { pluginIds?: string[]; externalChangesConfirmed?: boolean };
}

export type FeatureEventName = keyof FeatureEventPayloads;

type AssertSameKeys<A extends PropertyKey, B extends PropertyKey> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _eventMapCoversAllEvents: AssertSameKeys<(typeof FeatureEvents)[keyof typeof FeatureEvents], FeatureEventName> = true;
void _eventMapCoversAllEvents;

type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Type-safe EventBus for inter-feature communication: event names are limited
 * to `FeatureEventName` and each payload is checked against `FeatureEventPayloads`.
 * Features can emit events without knowing which other features are listening.
 */
export class EventBus {
    private handlers = new Map<FeatureEventName, Set<EventHandler<never>>>();

    /**
     * Subscribe to an event.
     */
    on<E extends FeatureEventName>(event: E, handler: EventHandler<FeatureEventPayloads[E]>): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
    }

    /**
     * Unsubscribe from an event.
     */
    off<E extends FeatureEventName>(event: E, handler: EventHandler<FeatureEventPayloads[E]>): void {
        this.handlers.get(event)?.delete(handler);
    }

    /**
     * Emit an event and wait for all handlers to complete.
     */
    async emit<E extends FeatureEventName>(event: E, payload: FeatureEventPayloads[E]): Promise<void> {
        const set = this.handlers.get(event) as Set<EventHandler<FeatureEventPayloads[E]>> | undefined;
        if (!set) return;

        const promises: Promise<void>[] = [];
        for (const handler of set) {
            try {
                const result = handler(payload);
                if (result instanceof Promise) {
                    promises.push(result);
                }
            } catch (error) {
                logger.error(`Error in handler for event "${event}":`, error);
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
