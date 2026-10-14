import { _electron, type ElectronApplication, type Page } from "playwright";
import { test as base, expect } from "obsidian-e2e-toolkit";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type CoverageEntries = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>;

const enabled = process.env.E2E_COVERAGE === "1";
const pages = new Map<Page, Promise<void>>();
const entries: CoverageEntries = [];

function startCoverage(page: Page): Promise<void> {
    const existing = pages.get(page);
    if (existing) return existing;
    const started = page.coverage.startJSCoverage({
        resetOnNavigation: false,
        reportAnonymousScripts: true,
    });
    // Window events cannot await the listener; keep errors for fixture teardown.
    void started.catch(() => {});
    pages.set(page, started);
    // The toolkit can replace a vault window; save its coverage before close.
    const close = page.close.bind(page);
    page.close = async (options) => {
        await collectCoverage(page);
        await close(options);
    };
    return started;
}

async function collectCoverage(page: Page): Promise<void> {
    const started = pages.get(page);
    if (!started) return;
    await started;
    if (!page.isClosed()) entries.push(...(await page.coverage.stopJSCoverage()));
    pages.delete(page);
}

export const test = base.extend({
    tempDir: async ({ tempDir }, use) => {
        if (!enabled) {
            await use(tempDir);
            return;
        }

        // The toolkit depends on tempDir before launching Electron. Hook launch
        // here so coverage starts before it installs and enables the plugins.
        const launch = _electron.launch;
        const applications: ElectronApplication[] = [];
        _electron.launch = async (options) => {
            const application = await launch.call(_electron, options);
            applications.push(application);
            application.on("window", startCoverage);
            await Promise.all(application.windows().map(startCoverage));
            return application;
        };
        try {
            await use(tempDir);
        } finally {
            _electron.launch = launch;
            for (const application of applications) application.off("window", startCoverage);
            pages.clear();
            entries.length = 0;
        }
    },
    obsidian: async ({ obsidian }, use, testInfo) => {
        try {
            await use(obsidian);
        } finally {
            if (enabled) {
                // Collect before the underlying toolkit fixture closes Electron.
                await Promise.all([...pages.keys()].map(collectCoverage));
                const pluginEntries = entries.filter((entry) => entry.url === "plugin:on-demand-plugins" || /[/\\]plugins[/\\]on-demand-plugins[/\\]main\.js/.test(entry.url));
                const directory = path.resolve("coverage/e2e/raw");
                await mkdir(directory, { recursive: true });
                await writeFile(path.join(directory, `${testInfo.testId}-${randomUUID()}.json`), JSON.stringify(pluginEntries));
            }
        }
    },
});

export { expect };
