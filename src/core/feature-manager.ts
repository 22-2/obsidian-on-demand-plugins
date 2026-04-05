import type { CoreContainer } from "src/services/core-container";
import type { EventBus } from "src/core/event-bus";
import type { AppFeature } from "src/core/feature";
import type { PluginContext } from "src/core/plugin-context";

export class FeatureManager {
    private features: AppFeature[] = [];

    ctx: PluginContext;
    core: CoreContainer;
    events: EventBus;

    constructor(ctx: PluginContext, core: CoreContainer, events: EventBus) {
        this.ctx = ctx;
        this.core = core;
        this.events = events;
    }

    register<T extends AppFeature>(feature: T): T {
        this.features.push(feature);
        return feature;
    }

    get<T extends AppFeature>(FeatureClass: new (...args: unknown[]) => T): T | undefined {
        return this.features.find((f): f is T => f instanceof FeatureClass);
    }

    async loadAll() {
        for (const feature of this.features) {
            await feature.onload(this.ctx, this.core, this, this.events);
        }
    }

    async unloadAll() {
        for (const feature of this.features) {
            await feature.onunload();
        }
    }
}
