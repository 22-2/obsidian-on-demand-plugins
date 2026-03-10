import type { CoreContainer } from "../services/core-container";
import type { EventBus } from "./event-bus";
import type { FeatureManager } from "./feature-manager";
import type { PluginContext } from "./plugin-context";

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
