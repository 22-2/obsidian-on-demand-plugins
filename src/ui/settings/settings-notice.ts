export function createSettingsNotice(container: HTMLElement, className: string, render: (paragraph: HTMLElement) => void) {
    const notice = container.createDiv({ cls: ["lazy-settings-notice", className] });
    render(notice.createEl("p"));
    return notice;
}
