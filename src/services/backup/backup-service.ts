import log from "loglevel";
import { moment, normalizePath } from "obsidian";
import type { PluginContext } from "../../core/plugin-context";
import type { PluginRegistry } from "../registry/plugin-registry";

const logger = log.getLogger("OnDemandPlugin/BackupService");

export class BackupService {
    private backupDir: string;

    constructor(
        private ctx: PluginContext,
        private registry: PluginRegistry,
    ) {
        const dir = this.ctx._plugin.manifest.dir;
        this.backupDir = normalizePath(`${dir}/backups`);
    }

    async ensureBackupFolder() {
        const adapter = this.ctx.app.vault.adapter;
        const exists = await adapter.exists(this.backupDir);
        if (!exists) {
            await adapter.mkdir(this.backupDir);
        }
    }

    async createBackup() {
        await this.ensureBackupFolder();
        const adapter = this.ctx.app.vault.adapter;

        // 1. Read files
        const dataPath = normalizePath(`${this.ctx._plugin.manifest.dir}/data.json`);
        const communityPath = this.registry.getCommunityPluginsConfigFilePath();

        let dataContent = "";
        let communityContent = "";

        try {
            dataContent = await adapter.read(dataPath);
            communityContent = await adapter.read(communityPath);
        } catch (e) {
            logger.warn("Could not read files for backup", e);
            return;
        }

        // 2. Validate json
        try {
            const dataParsed = JSON.parse(dataContent);
            if (!dataParsed || !dataParsed.profiles) {
                logger.warn("Invalid data.json for backup, skipping validation failed.");
                return;
            }
        } catch (e) {
            logger.warn("Failed to parse data.json for backup", e);
            return;
        }

        try {
            const communityParsed = JSON.parse(communityContent);
            if (!Array.isArray(communityParsed)) {
                logger.warn("Invalid community-plugins.json for backup, skipping");
                return;
            }
        } catch (e) {
            logger.warn("Failed to parse community-plugins.json for backup", e);
            return;
        }

        // 3. Save backup
        const timestamp = moment().format("YYYYMMDD-HHmmss");
        const dataBackupPath = normalizePath(`${this.backupDir}/data_${timestamp}.json`);
        const communityBackupPath = normalizePath(`${this.backupDir}/community-plugins_${timestamp}.json`);

        try {
            await adapter.write(dataBackupPath, dataContent);
            await adapter.write(communityBackupPath, communityContent);
            logger.info(`Created backup at ${timestamp}`);
        } catch (e) {
            logger.error("Failed to write backup files", e);
            return;
        }

        // 4. Rotate backups
        await this.rotateBackups();
    }

    private async rotateBackups() {
        const adapter = this.ctx.app.vault.adapter;
        let result;
        try {
            result = await adapter.list(this.backupDir);
        } catch (e) {
            return;
        }

        const dataBackups = result.files.filter((f) => f.includes("data_") && f.endsWith(".json")).sort();
        const communityBackups = result.files.filter((f) => f.includes("community-plugins_") && f.endsWith(".json")).sort();

        while (dataBackups.length > 3) {
            const oldest = dataBackups.shift();
            if (oldest) await adapter.remove(oldest);
        }

        while (communityBackups.length > 3) {
            const oldest = communityBackups.shift();
            if (oldest) await adapter.remove(oldest);
        }
    }
}
