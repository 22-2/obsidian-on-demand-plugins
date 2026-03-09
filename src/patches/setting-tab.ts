import { around } from "monkey-around";
import type { PluginContext } from "../core/plugin-context";
import { PluginManagementNoticeModal } from "../ui/modals/plugin-management-notice-modal";

export function patchSettingTabOpen(ctx: PluginContext): void {
    const settingApp = ctx.app.setting;
    if (!settingApp) return;

    ctx.register(
        around(settingApp, {
            openTab: (next) =>
                function (tab) {
                    const result = next.call(this, tab);

                    if (tab.id === "community-plugins" && !ctx.getData().suppressPluginManagementNotice) {
                        new PluginManagementNoticeModal(ctx.app, ctx).open();
                    }

                    return result;
                },
        }),
    );
}
