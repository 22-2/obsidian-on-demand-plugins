import type { App } from "obsidian";
import { Notice } from "src/__mocks__/obsidian";
import { showConfirmModal } from "src/core/confirm-modal";
import { createPageFixture } from "src/ui/settings/__mocks__/page-fixture";
import { elements, ui } from "src/ui/settings/__mocks__/settings-ui";
import type { UiElement } from "src/ui/settings/__mocks__/settings-ui";
import { openBackupDirectory } from "src/ui/settings/helpers";
import { ProfileManagementPage } from "src/ui/settings/pages/profile-management-page";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => ({
    ...(await import("src/__mocks__/obsidian")),
    ...(await import("src/ui/settings/__mocks__/settings-ui")),
}));
vi.mock("src/core/confirm-modal", () => ({ showConfirmModal: vi.fn() }));
vi.mock("src/ui/settings/helpers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ui/settings/helpers")>()),
    openBackupDirectory: vi.fn().mockResolvedValue(undefined),
}));

function setup() {
    const fixture = createPageFixture();
    const page = new ProfileManagementPage({} as App, fixture.plugin, fixture.tab);
    page.display();
    const root = page.containerEl as unknown as UiElement;
    const setting = (name: string) => ui.setting(name, root);
    const menuFor = async (name: string) => {
        const card = elements(root, "lazy-profile-card").find((candidate) => elements(candidate, "lazy-profile-name")[0].text === name);
        if (!card) throw new Error(`Profile card not found: ${name}`);
        const actions = ui.extras.findLast((button) => card.contains(button.parent));
        if (!actions) throw new Error(`Profile actions not found: ${name}`);
        await actions.click();
        return ui.menus.at(-1)!;
    };
    const rename = async (name: string) => {
        await (await menuFor(name)).item("Rename").click();
        const modal = ui.modals.at(-1)!;
        return { modal, input: ui.setting("Profile name", modal.contentEl).texts[0], save: ui.setting("", modal.contentEl).buttons[0] };
    };
    return { ...fixture, page, root, setting, menuFor, rename };
}

describe("ProfileManagementPage", () => {
    beforeEach(() => {
        ui.reset();
        vi.clearAllMocks();
        vi.mocked(showConfirmModal).mockReset().mockResolvedValue(true);
        Notice.clearMessages();
    });

    it("renders active, device-default and recovery badges and limits actions on the active profile", async () => {
        const { root, menuFor } = setup();
        const badges = elements(root, "lazy-profile-badge").map((badge) => badge.text);
        expect(badges).toEqual(["Active", "Desktop default", "Mobile default", "Initial backup"]);
        expect(elements(root, "lazy-profile-current-label").map((label) => label.text)).toEqual(["Current profile"]);
        const current = await menuFor("Home");
        expect(current.items.map((item) => item.text)).toEqual(["Rename", "Duplicate", "Open backup folder"]);
        const other = await menuFor("Spare");
        expect(other.items.map((item) => item.text)).toEqual(["Use this profile", "Rename", "Duplicate", "Open backup folder", "Delete"]);
        expect(other.position).toEqual({ x: 12, y: 34 });
    });

    it("does not offer deletion when only one profile remains", async () => {
        const { data, page, menuFor } = setup();
        data.profiles = { home: data.profiles.home };
        data.mobileProfileId = "home";
        page.display();
        expect((await menuFor("Home")).items.some((item) => item.text === "Delete")).toBe(false);
    });

    it("opens the backup directory from both the heading and a profile menu", async () => {
        const { setting, menuFor, plugin } = setup();
        await setting("Profiles").extras[0].click();
        await (await menuFor("Spare")).item("Open backup folder").click();
        expect(openBackupDirectory).toHaveBeenCalledTimes(2);
        expect(openBackupDirectory).toHaveBeenLastCalledWith(plugin);
    });

    it("requires a name, trims it when creating, and clears the form only after creation", async () => {
        const { setting, tabMock, root } = setup();
        const form = setting("Profile name");
        expect(form.buttons[0].disabled).toBe(true);
        await form.texts[0].change("   ");
        expect(form.buttons[0].disabled).toBe(true);
        await form.buttons[0].click();
        expect(tabMock.createProfile).not.toHaveBeenCalled();
        await form.texts[0].change("  Writing  ");
        expect(form.buttons[0].disabled).toBe(false);
        await form.buttons[0].click();
        await vi.waitFor(() => expect(elements(root, "lazy-profile-name").map((name) => name.text)).toContain("Writing"));
        expect(tabMock.createProfile).toHaveBeenCalledWith("Writing");
        expect(setting("Profile name").texts[0].value).toBe("");
        expect(setting("Profile name").buttons[0].disabled).toBe(true);
    });

    it("duplicates the selected profile through the immediate-save path", async () => {
        const { menuFor, tabMock, root } = setup();
        await (await menuFor("Work")).item("Duplicate").click();
        expect(tabMock.createProfile).toHaveBeenCalledWith("Work (Copy)", "work");
        expect(elements(root, "lazy-profile-name").map((name) => name.text)).toContain("Work (Copy)");
        expect(tabMock.markDirty).not.toHaveBeenCalled();
    });

    it.each(["Desktop", "Mobile"])("saves the %s default immediately without switching the current profile", async (label) => {
        const { setting, data, service, tabMock, pluginMock } = setup();
        await setting(label).dropdowns[0].change("spare");
        expect(data[label === "Desktop" ? "desktopProfileId" : "mobileProfileId"]).toBe("spare");
        expect(service.currentProfileId).toBe("home");
        expect(pluginMock.switchProfile).not.toHaveBeenCalled();
        expect(tabMock.saveImmediateChanges).toHaveBeenCalledOnce();
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        expect(setting(label).dropdowns[0].value).toBe("spare");
    });

    it("switches a clean profile only after earlier immediate saves finish", async () => {
        const { menuFor, tabMock, pluginMock, service, root } = setup();
        await (await menuFor("Spare")).item("Use this profile").click();
        await vi.waitFor(() => expect(tabMock.resetPending).toHaveBeenCalledOnce());
        expect(tabMock.waitForImmediateSaves.mock.invocationCallOrder[0]).toBeLessThan(pluginMock.switchProfile.mock.invocationCallOrder[0]);
        expect(service.currentProfileId).toBe("spare");
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(tabMock.discardPendingChanges).not.toHaveBeenCalled();
        expect(elements(root, "lazy-profile-card").filter((card) => card.className.includes("is-current"))).toHaveLength(1);
    });

    it("keeps the current profile and its draft when switching is canceled", async () => {
        const { menuFor, tabMock, pluginMock, service } = setup();
        tabMock.hasPendingChanges = true;
        vi.mocked(showConfirmModal).mockResolvedValueOnce(false);
        await (await menuFor("Spare")).item("Use this profile").click();
        await vi.waitFor(() => expect(showConfirmModal).toHaveBeenCalledOnce());
        expect(service.currentProfileId).toBe("home");
        expect(pluginMock.switchProfile).not.toHaveBeenCalled();
        expect(tabMock.discardPendingChanges).not.toHaveBeenCalled();
        expect(tabMock.resetPending).not.toHaveBeenCalled();
    });

    it("discards a confirmed draft before switching so it cannot be saved into the new profile", async () => {
        const { menuFor, tabMock, pluginMock } = setup();
        tabMock.hasPendingChanges = true;
        await (await menuFor("Spare")).item("Use this profile").click();
        await vi.waitFor(() => expect(tabMock.resetPending).toHaveBeenCalledOnce());
        expect(showConfirmModal).toHaveBeenCalledWith(expect.anything(), { message: "You have unsaved changes. Switch profile anyway?" });
        expect(tabMock.discardPendingChanges).toHaveBeenCalledWith(false);
        expect(tabMock.discardPendingChanges.mock.invocationCallOrder[0]).toBeLessThan(pluginMock.switchProfile.mock.invocationCallOrder[0]);
        expect(pluginMock.switchProfile).toHaveBeenCalledWith("spare");
    });

    it("does not save an empty rename or rewrite an unchanged name", async () => {
        const { rename, data, tabMock } = setup();
        const { modal, input, save } = await rename("Home");
        expect(modal.titleEl.text).toBe("Rename profile");
        await input.change("   ");
        await save.click();
        expect(modal.isOpen).toBe(true);
        await input.change(" Home ");
        await save.click();
        expect(modal.isOpen).toBe(false);
        expect(data.profiles.home.name).toBe("Home");
        expect(tabMock.saveImmediateChanges).not.toHaveBeenCalled();
    });

    it("saves a trimmed rename immediately and redraws its card", async () => {
        const { rename, root, tabMock } = setup();
        const { modal, input, save } = await rename("Spare");
        await input.change("  Writing  ");
        await save.click();
        expect(modal.isOpen).toBe(false);
        expect(elements(root, "lazy-profile-name").map((name) => name.text)).toContain("Writing");
        expect(tabMock.saveImmediateChanges).toHaveBeenCalledOnce();
        expect(tabMock.markDirty).not.toHaveBeenCalled();
    });

    it("keeps the rename dialog and original name when saving fails", async () => {
        const { rename, data, tabMock } = setup();
        const { modal, input, save } = await rename("Spare");
        await input.change("Writing");
        tabMock.saveImmediateChanges.mockRejectedValueOnce(new Error("write failed"));
        await expect(save.click()).rejects.toThrow("write failed");
        expect(modal.isOpen).toBe(true);
        expect(data.profiles.spare.name).toBe("Spare");
    });

    it.each(["desktop", "mobile"])("prevents deleting a profile still assigned as the %s default", async (device) => {
        const { menuFor, data, tabMock } = setup();
        data[device === "desktop" ? "desktopProfileId" : "mobileProfileId"] = "spare";
        await (await menuFor("Spare")).item("Delete").click();
        expect(Notice.messages).toEqual(["Assign another device default before deleting this profile."]);
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(tabMock.saveImmediateChanges).not.toHaveBeenCalled();
        expect(data.profiles.spare).toBeDefined();
    });

    it("keeps a profile when deletion is canceled", async () => {
        const { menuFor, data, tabMock } = setup();
        vi.mocked(showConfirmModal).mockResolvedValueOnce(false);
        await (await menuFor("Spare")).item("Delete").click();
        await vi.waitFor(() => expect(showConfirmModal).toHaveBeenCalledOnce());
        expect(showConfirmModal).toHaveBeenCalledWith(expect.anything(), { message: 'Delete profile "Spare"?' });
        expect(data.profiles.spare).toBeDefined();
        expect(tabMock.saveImmediateChanges).not.toHaveBeenCalled();
    });

    it.each(["Spare", "Initial backup"])("requires confirmation and immediately deletes %s", async (name) => {
        const { menuFor, data, root, tabMock } = setup();
        const id = name === "Spare" ? "spare" : "initial-backup";
        await (await menuFor(name)).item("Delete").click();
        await vi.waitFor(() => expect(elements(root, "lazy-profile-name").map((element) => element.text)).not.toContain(name));
        expect(data.profiles[id]).toBeUndefined();
        expect(tabMock.saveImmediateChanges).toHaveBeenCalledOnce();
        expect(tabMock.markDirty).not.toHaveBeenCalled();
        const message = vi.mocked(showConfirmModal).mock.calls[0][1].message;
        expect(message).toContain(name);
        if (id === "initial-backup") expect(message).toContain("failsafe initial backup");
    });
});
