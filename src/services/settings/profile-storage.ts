import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import type { Profile } from "src/core/types";
import type OnDemandPlugin from "src/main";

export interface ProfileStorageLoadResult {
    available: boolean;
    filesFound: boolean;
    profiles: Record<string, Profile>;
    corruptPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseProfile(value: unknown): Profile | undefined {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.settings)) {
        return undefined;
    }

    return {
        id: value.id,
        name: value.name,
        settings: value.settings as unknown as Profile["settings"],
    };
}

export class ProfileStorage {
    private readonly adapter?: DataAdapter;
    private readonly profilesDir?: string;

    constructor(plugin: OnDemandPlugin) {
        const candidate = plugin as unknown as {
            app?: { vault?: { adapter?: DataAdapter } };
            manifest?: { dir?: string };
        };
        this.adapter = candidate.app?.vault?.adapter;
        const pluginDir = candidate.manifest?.dir;
        if (pluginDir) {
            this.profilesDir = normalizePath(`${pluginDir}/profiles`);
        }
    }

    async load(): Promise<ProfileStorageLoadResult> {
        const empty: ProfileStorageLoadResult = {
            available: false,
            filesFound: false,
            profiles: {},
            corruptPaths: [],
        };
        if (!this.adapter || !this.profilesDir) return empty;

        let files: string[];
        try {
            if (!(await this.adapter.exists(this.profilesDir))) {
                return { ...empty, available: true };
            }
            files = (await this.adapter.list(this.profilesDir)).files;
        } catch {
            return empty;
        }

        const profilePaths = new Set<string>();
        for (const path of files) {
            if (path.endsWith(".json")) profilePaths.add(path);
            if (path.endsWith(".json.bak")) profilePaths.add(path.slice(0, -4));
        }

        const result: ProfileStorageLoadResult = {
            available: true,
            filesFound: profilePaths.size > 0,
            profiles: {},
            corruptPaths: [],
        };

        for (const path of profilePaths) {
            const candidates = [path, `${path}.bak`];
            let profile: Profile | undefined;
            for (const candidatePath of candidates) {
                try {
                    profile = parseProfile(JSON.parse(await this.adapter.read(candidatePath)));
                } catch {
                    profile = undefined;
                }
                if (profile) break;
            }

            if (!profile) {
                result.corruptPaths.push(path);
                continue;
            }
            if (!result.profiles[profile.id]) result.profiles[profile.id] = profile;
        }

        return result;
    }

    async save(profiles: Record<string, Profile>): Promise<void> {
        if (!this.adapter || !this.profilesDir) return;

        if (!(await this.adapter.exists(this.profilesDir))) {
            await this.adapter.mkdir(this.profilesDir);
        }

        const existingFiles = (await this.adapter.list(this.profilesDir)).files;
        const currentIds = new Set(Object.keys(profiles));

        for (const profile of Object.values(profiles)) {
            const path = this.profilePath(profile.id);
            if (await this.adapter.exists(path)) {
                const previous = await this.adapter.read(path);
                await this.adapter.write(`${path}.bak`, previous);
            }
            await this.adapter.write(path, JSON.stringify(profile, null, 2));
        }

        for (const path of existingFiles.filter((candidate) => candidate.endsWith(".json") && !candidate.endsWith(".json.bak"))) {
            const id = this.idFromPath(path);
            if (!id || currentIds.has(id)) continue;
            await this.adapter.remove(path);
            if (await this.adapter.exists(`${path}.bak`)) await this.adapter.remove(`${path}.bak`);
        }
    }

    private profilePath(id: string): string {
        return normalizePath(`${this.profilesDir}/${encodeURIComponent(id)}.json`);
    }

    private idFromPath(path: string): string | undefined {
        if (!this.profilesDir || !path.startsWith(`${this.profilesDir}/`) || !path.endsWith(".json")) return undefined;
        const encoded = path.slice(`${this.profilesDir}/`.length, -5);
        try {
            return decodeURIComponent(encoded);
        } catch {
            return undefined;
        }
    }
}
