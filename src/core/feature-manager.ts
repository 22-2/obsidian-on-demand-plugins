import type { CoreContainer } from "../services/core-container";
import type { AppFeature } from "./feature";
import type { PluginContext } from "./plugin-context";

export class FeatureManager {
    private features: AppFeature[] = [];

    constructor(
        private ctx: PluginContext,
        private core: CoreContainer,
    ) {}

    register(feature: AppFeature) {
        this.features.push(feature);
    }

    async loadAll() {
        for (const feature of this.features) {
            await feature.onload(this.ctx, this.core);
        }
    }

    async unloadAll() {
        for (const feature of this.features) {
            await feature.onunload();
        }
    }
}
