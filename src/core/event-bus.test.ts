import { EventBus, FeatureEvents } from "src/core/event-bus";
import { describe, expect, it, vi } from "vitest";

describe("EventBus", () => {
    it("delivers the payload to every handler and awaits async ones", async () => {
        const bus = new EventBus();
        const order: string[] = [];
        bus.on(FeatureEvents.APPLY_POLICIES_REQUESTED, (payload) => {
            order.push(`sync:${payload.pluginIds?.join(",")}`);
        });
        bus.on(FeatureEvents.APPLY_POLICIES_REQUESTED, async (payload) => {
            await Promise.resolve();
            order.push(`async:${String(payload.externalChangesConfirmed)}`);
        });

        await bus.emit(FeatureEvents.APPLY_POLICIES_REQUESTED, { pluginIds: ["a", "b"], externalChangesConfirmed: true });

        expect(order).toEqual(["sync:a,b", "async:true"]);
    });

    it("stops delivering after off and keeps going when a handler throws", async () => {
        const bus = new EventBus();
        const removed = vi.fn();
        const after = vi.fn();
        bus.on(FeatureEvents.REBUILD_CACHE_REQUESTED, removed);
        bus.off(FeatureEvents.REBUILD_CACHE_REQUESTED, removed);
        bus.on(FeatureEvents.REBUILD_CACHE_REQUESTED, () => {
            throw new Error("boom");
        });
        bus.on(FeatureEvents.REBUILD_CACHE_REQUESTED, after);

        await bus.emit(FeatureEvents.REBUILD_CACHE_REQUESTED, { force: true });

        expect(removed).not.toHaveBeenCalled();
        expect(after).toHaveBeenCalledWith({ force: true });
    });

    it("rejects unknown events and mismatched payloads at compile time", () => {
        const bus = new EventBus();
        const typeChecks = () => {
            // @ts-expect-error unknown event name
            void bus.emit("lazy-engine:unknown", {});
            // @ts-expect-error pluginIds belongs to APPLY_POLICIES_REQUESTED
            void bus.emit(FeatureEvents.REBUILD_CACHE_REQUESTED, { pluginIds: [] });
            // @ts-expect-error force must be a boolean
            bus.on(FeatureEvents.REBUILD_CACHE_REQUESTED, (payload: { force?: string }) => void payload);
        };
        expect(typeChecks).toBeTypeOf("function");
    });
});
