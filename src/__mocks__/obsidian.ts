export const App = class {};
export const Modal = class {};
export const Plugin = class {};
export const Setting = class {};
export const Notice = class {};
export const ExtraButtonComponent = class {};
export const Menu = class {};
export const DropdownComponent = class {};
export const ButtonComponent = class {};
export const setIcon = () => {};

export function normalizePath(path: string): string {
    return path;
}

export const Platform = {
    isDesktop: true,
    isMobile: false,
};

export const MarkdownView = class {
    getMode() {
        return "source";
    }
};
