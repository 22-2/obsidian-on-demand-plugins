type ElementOptions = { cls?: string | string[]; text?: string };
type Handler<T = void> = (value: T) => unknown;

export class UiElement {
    tag: string;
    children: UiElement[] = [];
    parent?: UiElement;
    className: string;
    text: string;
    open = false;
    private listeners = new Map<string, () => void>();

    constructor(tag = "div", options: ElementOptions = {}) {
        this.tag = tag;
        this.className = Array.isArray(options.cls) ? options.cls.join(" ") : (options.cls ?? "");
        this.text = options.text ?? "";
    }
    empty() {
        this.children.forEach((child) => {
            child.parent = undefined;
        });
        this.children = [];
    }
    addClass(name: string) {
        this.className += ` ${name}`;
    }
    setAttr(_name: string, _value: string) {}
    setText(text: string) {
        this.text = text;
    }
    appendText(text: string) {
        this.text += text;
    }
    private createChild(tag: string, options?: ElementOptions): UiElement {
        const child = new UiElement(tag, options);
        child.parent = this;
        this.children.push(child);
        return child;
    }
    createEl(tag: string, options?: ElementOptions) {
        return this.createChild(tag, options);
    }
    createDiv(options?: ElementOptions) {
        return this.createChild("div", options);
    }
    createSpan(options?: ElementOptions) {
        return this.createChild("span", options);
    }
    prepend(child: UiElement) {
        this.children = [child, ...this.children.filter((item) => item !== child)];
        child.parent = this;
    }
    addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
    }
    dispatch(event: string) {
        this.listeners.get(event)?.();
    }
    getBoundingClientRect() {
        return { left: 12, bottom: 34 };
    }
    contains(element: UiElement): boolean {
        return this === element || this.children.some((child) => child.contains(element));
    }
}

export class UiControl<T = string> {
    parent: UiElement;
    text = "";
    value?: T;
    disabled = false;
    disabledHistory: boolean[] = [];
    options = new Map<string, string>();
    private clickHandler?: () => unknown;
    private changeHandler?: Handler<T>;
    constructor(parent: UiElement) {
        this.parent = parent;
    }
    setButtonText(text: string) {
        this.text = text;
        return this;
    }
    setTooltip(text: string) {
        this.text = text;
        return this;
    }
    setIcon(_icon: string) {
        return this;
    }
    setPlaceholder(_placeholder: string) {
        return this;
    }
    setDestructive() {
        return this;
    }
    setCta() {
        return this;
    }
    setDisabled(value: boolean) {
        this.disabled = value;
        this.disabledHistory.push(value);
        return this;
    }
    setValue(value: T) {
        this.value = value;
        return this;
    }
    addOption(value: string, label: string) {
        this.options.set(value, label);
        return this;
    }
    onClick(handler: () => unknown) {
        this.clickHandler = handler;
        return this;
    }
    onChange(handler: Handler<T>) {
        this.changeHandler = handler;
        return this;
    }
    async click() {
        if (!this.disabled) await this.clickHandler?.();
    }
    async change(value: T) {
        this.value = value;
        await this.changeHandler?.(value);
    }
}

export const ui = {
    settings: [] as Setting[],
    extras: [] as ExtraButtonComponent[],
    menus: [] as Menu[],
    modals: [] as Modal[],
    reset() {
        this.settings = [];
        this.extras = [];
        this.menus = [];
        this.modals = [];
    },
    setting(name: string, root: UiElement): Setting {
        const setting = this.settings.findLast((candidate) => candidate.name === name && root.contains(candidate.settingEl));
        if (!setting) throw new Error(`Setting not found: ${name}`);
        return setting;
    },
};

export class ExtraButtonComponent extends UiControl {
    constructor(parent: UiElement) {
        super(parent);
        ui.extras.push(this);
    }
}

export class Setting {
    name = "";
    desc = "";
    settingEl: UiElement;
    buttons: UiControl[] = [];
    texts: UiControl[] = [];
    dropdowns: UiControl[] = [];
    toggles: UiControl<boolean>[] = [];
    extras: ExtraButtonComponent[] = [];
    constructor(parent: UiElement) {
        this.settingEl = parent.createDiv();
        ui.settings.push(this);
    }
    setName(name: string) {
        this.name = name;
        return this;
    }
    setDesc(desc: string) {
        this.desc = desc;
        return this;
    }
    setHeading() {
        return this;
    }
    addButton(build: (control: UiControl) => unknown) {
        const control = new UiControl(this.settingEl);
        this.buttons.push(control);
        build(control);
        return this;
    }
    addText(build: (control: UiControl) => unknown) {
        const control = new UiControl(this.settingEl);
        this.texts.push(control);
        build(control);
        return this;
    }
    addDropdown(build: (control: UiControl) => unknown) {
        const control = new UiControl(this.settingEl);
        this.dropdowns.push(control);
        build(control);
        return this;
    }
    addToggle(build: (control: UiControl<boolean>) => unknown) {
        const control = new UiControl<boolean>(this.settingEl);
        this.toggles.push(control);
        build(control);
        return this;
    }
    addExtraButton(build: (control: ExtraButtonComponent) => unknown) {
        const control = new ExtraButtonComponent(this.settingEl);
        this.extras.push(control);
        build(control);
        return this;
    }
}

export class SettingPage {
    containerEl = new UiElement();
}

class MenuItem extends UiControl {
    setTitle(title: string) {
        this.text = title;
        return this;
    }
    setWarning(_warning: boolean) {
        return this;
    }
}

export class Menu {
    items: MenuItem[] = [];
    position?: { x: number; y: number };
    constructor() {
        ui.menus.push(this);
    }
    addItem(build: (item: MenuItem) => unknown) {
        const item = new MenuItem(new UiElement());
        this.items.push(item);
        build(item);
        return this;
    }
    addSeparator() {
        return this;
    }
    showAtPosition(position: { x: number; y: number }) {
        this.position = position;
    }
    item(title: string): MenuItem {
        const item = this.items.find((candidate) => candidate.text === title);
        if (!item) throw new Error(`Menu item not found: ${title}`);
        return item;
    }
}

export class Modal {
    contentEl = new UiElement();
    titleEl = new UiElement();
    isOpen = false;
    constructor(_app: unknown) {
        ui.modals.push(this);
    }
    open() {
        this.isOpen = true;
    }
    close() {
        this.isOpen = false;
    }
}

export function elements(root: UiElement, className: string): UiElement[] {
    return [...(root.className.split(" ").includes(className) ? [root] : []), ...root.children.flatMap((child) => elements(child, className))];
}
