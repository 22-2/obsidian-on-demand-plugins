import log from "loglevel";
import type { AppFeature } from "src/core/feature";
import type { PluginContext } from "src/core/plugin-context";

// Needed dynamic import from obsidian
import { normalizePath } from "obsidian";

const logger = log.getLogger("OnDemandPlugin/BackupFeature");
const INITIAL_INSTALL_BACKUP_DIRNAME = "initial-install";

function hasProfilesRecord(value: unknown): value is { profiles: Record<string, unknown> } {
    return typeof value === "object" && value !== null && "profiles" in value && typeof value.profiles === "object" && value.profiles !== null;
}

function hasExternalProfileStorage(value: unknown): value is { profileStorageVersion: number } {
    return typeof value === "object" && value !== null && "profileStorageVersion" in value && value.profileStorageVersion === 1;
}

export class BackupFeature implements AppFeature {
    private backupDir!: string;
    private ctx!: PluginContext;

    async onload(ctx: PluginContext) {
        this.ctx = ctx;
        const dir = this.ctx._plugin.manifest.dir;
        this.backupDir = normalizePath(`${dir}/backups`);

        await this.createInitialInstallBackupIfNeeded();

        // Whenever settings are saved, we create a backup
        // @ts-expect-error - Custom workspace event
        this.ctx.app.workspace.on("ondemand-plugins:settings-saved", () => {
            void this.createBackup();
        });
    }

    onunload() {
        // No teardown necessary
    }

    async ensureBackupFolder() {
        const adapter = this.ctx.app.vault.adapter;
        const exists = await adapter.exists(this.backupDir);
        if (!exists) {
            await adapter.mkdir(this.backupDir);
        }
    }

    private async createInitialInstallBackupIfNeeded() {
        if (!this.ctx) return;

        const initialBackupDir = normalizePath(`${this.backupDir}/${INITIAL_INSTALL_BACKUP_DIRNAME}`);
        const adapter = this.ctx.app.vault.adapter;

        await this.ensureBackupFolder();

        if (!(await adapter.exists(initialBackupDir))) {
            await adapter.mkdir(initialBackupDir);
        }

        const dataBackupPath = normalizePath(`${initialBackupDir}/data.json`);
        const communityBackupPath = normalizePath(`${initialBackupDir}/community-plugins.json`);
        const profileBackupPath = normalizePath(`${initialBackupDir}/profiles.json`);

        // Reason: this snapshot represents the post-install baseline and must remain immutable,
        // so once both files exist we never overwrite them on later loads.
        if ((await adapter.exists(dataBackupPath)) && (await adapter.exists(communityBackupPath))) {
            return;
        }

        await this.createBackup({
            dataBackupPath,
            communityBackupPath,
            profileBackupPath,
            rotate: false,
        });
    }

    async createBackup(options?: { dataBackupPath?: string; communityBackupPath?: string; profileBackupPath?: string; rotate?: boolean }) {
        if (!this.ctx) return;

        await this.ensureBackupFolder();
        const adapter = this.ctx.app.vault.adapter;

        // 1. Read files
        const dataPath = normalizePath(`${this.ctx._plugin.manifest.dir}/data.json`);
        const communityPath = this.ctx.app.vault.getConfigFile("community-plugins");

        let dataContent: string;
        let communityContent: string;
        let profilesContent: string | undefined;

        try {
            dataContent = await adapter.read(dataPath);
            communityContent = await adapter.read(communityPath);
        } catch (e) {
            logger.warn("Could not read files for backup", e);
            return;
        }

        // 2. Validate json
        try {
            const dataParsed: unknown = JSON.parse(dataContent);
            if (!hasProfilesRecord(dataParsed) && !hasExternalProfileStorage(dataParsed)) {
                logger.warn("Invalid data.json for backup, skipping validation failed.");
                return;
            }
        } catch (e) {
            logger.warn("Failed to parse data.json for backup", e);
            return;
        }

        try {
            profilesContent = await this.readProfilesSnapshot();
        } catch (e) {
            logger.warn("Failed to read external profiles for backup", e);
        }

        try {
            const communityParsed: unknown = JSON.parse(communityContent);
            if (!Array.isArray(communityParsed)) {
                logger.warn("Invalid community-plugins.json for backup, skipping");
                return;
            }
        } catch (e) {
            logger.warn("Failed to parse community-plugins.json for backup", e);
            return;
        }

        // 3. Save backup
        const timestamp = window.moment().format("YYYYMMDD-HHmmss");
        const dataBackupPath = options?.dataBackupPath ?? normalizePath(`${this.backupDir}/data_${timestamp}.json`);
        const communityBackupPath = options?.communityBackupPath ?? normalizePath(`${this.backupDir}/community-plugins_${timestamp}.json`);
        const profileBackupPath = options?.profileBackupPath ?? normalizePath(`${this.backupDir}/profiles_${timestamp}.json`);

        try {
            // Write the metadata, community plugin list, and external profiles.
            await adapter.write(dataBackupPath, dataContent);
            await adapter.write(communityBackupPath, communityContent);
            if (profilesContent) await adapter.write(profileBackupPath, profilesContent);
            logger.info(`Created backups at ${timestamp}`);
        } catch (e) {
            logger.error("Failed to write backup files", e);
            return;
        }

        // 4. Rotate backups
        if (options?.rotate !== false) {
            await this.rotateBackups();
        }
    }

    private async rotateBackups() {
        const adapter = this.ctx.app.vault.adapter;
        let result;
        try {
            result = await adapter.list(this.backupDir);
        } catch (e) {
            logger.warn("Failed to list backup directory for rotation, skipping rotation", e);
            return;
        }

        const dataBackups = result.files.filter((f) => f.includes("data_") && f.endsWith(".json")).sort();
        const communityBackups = result.files.filter((f) => f.includes("community-plugins_") && f.endsWith(".json")).sort();
        const profileBackups = result.files.filter((f) => f.includes("profiles_") && f.endsWith(".json")).sort();

        while (dataBackups.length > 3) {
            const oldest = dataBackups.shift();
            if (!oldest) continue;

            // Reason: Another process or a previous operation may have already removed the file,
            // and `adapter.remove` may throw ENOENT which would lead to an unhandled Promise rejection.
            // Therefore, ignore ENOENT but log any other errors.
            try {
                await adapter.remove(oldest);
            } catch (e) {
                const err = e as { code?: string } | undefined;
                if (err?.code === "ENOENT") {
                    logger.warn(`Backup already removed, skipping: ${oldest}`);
                } else {
                    logger.error(`Failed to remove backup ${oldest}`, e);
                }
            }
        }

        while (communityBackups.length > 3) {
            const oldest = communityBackups.shift();
            if (!oldest) continue;

            // Same handling as above: ignore ENOENT if the file was already removed, and log other errors.
            try {
                if (await adapter.exists(oldest)) {
                    await adapter.remove(oldest);
                }
            } catch (e) {
                const err = e as { code?: string } | undefined;
                if (err?.code === "ENOENT") {
                    logger.warn(`Backup already removed, skipping: ${oldest}`);
                } else {
                    logger.error(`Failed to remove backup ${oldest}`, e);
                }
            }
        }

        while (profileBackups.length > 3) {
            const oldest = profileBackups.shift();
            if (!oldest) continue;

            try {
                if (await adapter.exists(oldest)) {
                    await adapter.remove(oldest);
                }
            } catch (e) {
                const err = e as { code?: string } | undefined;
                if (err?.code === "ENOENT") {
                    logger.warn(`Profile backup already removed, skipping: ${oldest}`);
                } else {
                    logger.error(`Failed to remove profile backup ${oldest}`, e);
                }
            }
        }
    }

    private async readProfilesSnapshot(): Promise<string | undefined> {
        const adapter = this.ctx.app.vault.adapter;
        const profilesDir = normalizePath(`${this.ctx._plugin.manifest.dir}/profiles`);
        if (!(await adapter.exists(profilesDir))) return undefined;

        const { files } = await adapter.list(profilesDir);
        const profileFiles = files.filter((path) => path.endsWith(".json") && !path.endsWith(".json.bak"));
        if (profileFiles.length === 0) return undefined;

        const contents: Record<string, string> = {};
        for (const path of profileFiles) {
            contents[path.slice(`${profilesDir}/`.length)] = await adapter.read(path);
        }
        return JSON.stringify({ version: 1, files: contents });
    }
}
