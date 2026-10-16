/**
 * DOM-backed stand-ins for the Obsidian components the plugin table builds, so its
 * tests can click and select real elements. Requires installObsidianDom().
 */
export class ExtraButtonComponent {
    extraSettingsEl: HTMLElement;
    disabled = false;
    tooltip = "";
    icon = "";
    constructor(container: HTMLElement) {
        this.extraSettingsEl = container.createDiv({ cls: "clickable-icon extra-setting-button" });
    }
    setIcon(icon: string) {
        this.icon = icon;
        return this;
    }
    setTooltip(tooltip: string) {
        this.tooltip = tooltip;
        return this;
    }
    setDisabled(disabled: boolean) {
        this.disabled = disabled;
        return this;
    }
    onClick(callback: () => void) {
        this.extraSettingsEl.addEventListener("click", () => {
            if (!this.disabled) callback();
        });
        return this;
    }
}

export class DropdownComponent {
    selectEl: HTMLSelectElement;
    constructor(container: HTMLElement) {
        this.selectEl = container.createEl("select", { cls: "dropdown" });
    }
    addOption(value: string, display: string) {
        this.selectEl.createEl("option", { value, text: display });
        return this;
    }
    setValue(value: string) {
        this.selectEl.value = value;
        return this;
    }
    getValue() {
        return this.selectEl.value;
    }
    onChange(callback: (value: string) => void) {
        this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
        return this;
    }
}

export class ButtonComponent {
    buttonEl: HTMLButtonElement;
    constructor(container: HTMLElement) {
        this.buttonEl = container.createEl("button");
    }
    setButtonText(text: string) {
        this.buttonEl.textContent = text;
        return this;
    }
    setCta() {
        this.buttonEl.addClass("mod-cta");
        return this;
    }
    setDisabled(disabled: boolean) {
        this.buttonEl.disabled = disabled;
        return this;
    }
    onClick(callback: () => void) {
        this.buttonEl.addEventListener("click", () => callback());
        return this;
    }
}

export class MenuItem {
    title = "";
    icon = "";
    checked = false;
    disabled = false;
    submenu?: Menu;
    private callback?: () => void;
    setTitle(title: string) {
        this.title = title;
        return this;
    }
    setIcon(icon: string) {
        this.icon = icon;
        return this;
    }
    setChecked(checked: boolean) {
        this.checked = checked;
        return this;
    }
    setDisabled(disabled: boolean) {
        this.disabled = disabled;
        return this;
    }
    setWarning() {
        return this;
    }
    onClick(callback: () => void) {
        this.callback = callback;
        return this;
    }
    setSubmenu() {
        this.submenu = new Menu();
        return this.submenu;
    }
    click() {
        this.callback?.();
    }
}

export class Menu {
    /** Menus shown so far, newest last. */
    static shown: Menu[] = [];
    items: MenuItem[] = [];
    position?: { x: number; y: number };
    addItem(callback: (item: MenuItem) => unknown) {
        const item = new MenuItem();
        callback(item);
        this.items.push(item);
        return this;
    }
    addSeparator() {
        return this;
    }
    showAtMouseEvent(evt: MouseEvent) {
        this.position = { x: evt.clientX, y: evt.clientY };
        Menu.shown.push(this);
        return this;
    }
    showAtPosition(position: { x: number; y: number }) {
        this.position = position;
        Menu.shown.push(this);
        return this;
    }
    /** The item with this title, searching submenus too. */
    find(title: string): MenuItem | undefined {
        for (const item of this.items) {
            if (item.title === title) return item;
            const nested = item.submenu?.find(title);
            if (nested) return nested;
        }
        return undefined;
    }
    static last(): Menu {
        const menu = Menu.shown.at(-1);
        if (!menu) throw new Error("No menu was shown");
        return menu;
    }
}

type EventRefLike = { off: () => void };

export class ItemView {
    app: unknown;
    leaf: unknown;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    actions: { icon: string; title: string; callback: () => void }[] = [];
    registeredEvents: EventRefLike[] = [];
    constructor(leaf: { app?: unknown }) {
        this.leaf = leaf;
        this.app = leaf.app;
        this.containerEl = createDiv();
        this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
    }
    addAction(icon: string, title: string, callback: () => void) {
        this.actions.push({ icon, title, callback });
        return createDiv();
    }
    registerEvent(ref: EventRefLike) {
        this.registeredEvents.push(ref);
    }
}
