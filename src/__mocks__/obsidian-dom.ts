/**
 * The subset of Obsidian's DOM helpers that the UI code uses, for tests running
 * under happy-dom. Obsidian adds these to the DOM prototypes at startup.
 */
type DomElementInfo = {
    cls?: string | string[];
    text?: string;
    attr?: Record<string, string | number | boolean | null>;
    type?: string;
    value?: string;
};

function applyInfo(el: HTMLElement, info?: DomElementInfo | string) {
    if (typeof info === "string") {
        el.className = info;
        return;
    }
    if (!info) return;
    const classes = Array.isArray(info.cls) ? info.cls : info.cls?.split(" ");
    if (classes) el.classList.add(...classes.filter(Boolean));
    if (info.text !== undefined) el.textContent = info.text;
    for (const [key, value] of Object.entries(info.attr ?? {})) if (value !== null) el.setAttribute(key, String(value));
    if (info.type !== undefined) el.setAttribute("type", info.type);
    if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** Built with createElementNS: the plain factories are what Obsidian's helpers wrap, and this file stands in for them. */
function newElement(tag: string, info?: DomElementInfo | string): HTMLElement {
    const el = document.createElementNS(HTML_NAMESPACE, tag);
    applyInfo(el, info);
    return el;
}

function createEl(this: Node, tag: string, info?: DomElementInfo | string, callback?: (el: HTMLElement) => void): HTMLElement {
    const el = newElement(tag, info);
    this.appendChild(el);
    callback?.(el);
    return el;
}

export function installObsidianDom() {
    const nodeProto = Node.prototype as unknown as Record<string, unknown>;
    nodeProto.createEl = createEl;
    nodeProto.createDiv = function (this: Node, info?: DomElementInfo | string, callback?: (el: HTMLElement) => void) {
        return createEl.call(this, "div", info, callback);
    };
    nodeProto.createSpan = function (this: Node, info?: DomElementInfo | string, callback?: (el: HTMLElement) => void) {
        return createEl.call(this, "span", info, callback);
    };
    nodeProto.empty = function (this: Node) {
        while (this.firstChild) this.removeChild(this.firstChild);
    };
    nodeProto.setText = function (this: Node, text: string) {
        this.textContent = text;
    };
    nodeProto.appendText = function (this: Node, text: string) {
        this.appendChild((this.ownerDocument ?? document).createTextNode(text));
    };
    Object.defineProperty(Node.prototype, "doc", { configurable: true, get: () => document });
    Object.defineProperty(Node.prototype, "win", { configurable: true, get: () => window });

    const elementProto = Element.prototype as unknown as Record<string, unknown>;
    elementProto.addClass = function (this: Element, ...classes: string[]) {
        this.classList.add(...classes);
    };
    elementProto.removeClass = function (this: Element, ...classes: string[]) {
        this.classList.remove(...classes);
    };
    elementProto.hasClass = function (this: Element, cls: string) {
        return this.classList.contains(cls);
    };
    elementProto.toggleClass = function (this: Element, cls: string, value: boolean) {
        this.classList.toggle(cls, value);
    };
    elementProto.setAttr = function (this: Element, key: string, value: string | number | boolean | null) {
        if (value === null) this.removeAttribute(key);
        else this.setAttribute(key, String(value));
    };
    elementProto.toggle = function (this: HTMLElement, show: boolean) {
        this.style.display = show ? "" : "none";
    };

    const globals = window as unknown as Record<string, unknown>;
    globals.createFragment = (callback?: (fragment: DocumentFragment) => void) => {
        const fragment = new DocumentFragment();
        callback?.(fragment);
        return fragment;
    };
    globals.createDiv = (info?: DomElementInfo | string) => newElement("div", info);
}
