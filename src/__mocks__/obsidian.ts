export const App = class {};
export const Modal = class {};
export const FuzzySuggestModal = class {};
export const Plugin = class {};
export const Setting = class {};
export const Notice = class {
    static messages: string[] = [];
    hidden = false;

    constructor(message?: string) {
        if (typeof message === "string") {
            Notice.messages.push(message);
        }
    }

    setMessage(message: string) {
        Notice.messages.push(message);
        return this;
    }

    hide() {
        this.hidden = true;
    }

    static clearMessages() {
        Notice.messages = [];
    }
};
export const ExtraButtonComponent = class {};
export const Menu = class {};
export const DropdownComponent = class {};
export const ButtonComponent = class {};
export const setIcon = () => {};

export class FileSystemAdapter {
    getBasePath() {
        return "vault";
    }
}

export class TFile {
    basename = "";
    name = "";
    path = "";
}

/** Runs at once, so nothing is ever pending for `run` or `cancel`. */
export function debounce<T extends unknown[], V>(fn: (...args: [...T]) => V, _timeout?: number, _resetTimer?: boolean) {
    const debounced = Object.assign((...args: [...T]) => {
        fn(...args);
        return debounced;
    }, {
        cancel: () => debounced,
        run: (): V | void => undefined,
    });
    return debounced;
}

export function normalizePath(path: string): string {
    return path;
}

export const Platform = {
    isDesktop: true,
    isMobile: false,
    isDesktopApp: false,
};

export const MarkdownView = class {
    getMode() {
        return "source";
    }
};
