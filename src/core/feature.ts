import type { EventBus } from "src/core/event-bus";
import type { FeatureManager } from "src/core/feature-manager";
import type { PluginContext } from "src/core/plugin-context";
import type { CoreContainer } from "src/services/core-container";

/**
 * Interface that all Features must implement.
 * Features should be independent functional blocks that rely on standard context
 * and avoid direct dependencies on each other.
 */
export interface AppFeature {
    /**
     * Called when the feature is loaded.
     */
    onload(ctx: PluginContext, core: CoreContainer, features: FeatureManager, events: EventBus): void | Promise<void>;

    /**
     * Called when the feature is unloaded (e.g., plugin reload/disable).
     */
    onunload(): void | Promise<void>;
}
