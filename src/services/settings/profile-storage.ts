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
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

        // Only current profile files may be migrated into data.json. A .bak can
        // be stale after a deliberate deletion, so using it here could resurrect
        // profiles the user removed.
        const profilePaths = files.filter((path) => path.endsWith(".json") && !path.endsWith(".json.bak"));

        const result: ProfileStorageLoadResult = {
            available: true,
            filesFound: profilePaths.length > 0,
            profiles: {},
            corruptPaths: [],
        };

        for (const path of profilePaths) {
            let profile: Profile | undefined;
            try {
                profile = parseProfile(JSON.parse(await this.adapter.read(path)));
            } catch {
                profile = undefined;
            }
            if (!profile) {
                result.corruptPaths.push(path);
                continue;
            }
            const expectedId = this.idFromPath(path);
            if (profile.id !== expectedId || result.profiles[profile.id]) {
                result.corruptPaths.push(path);
                continue;
            }
            result.profiles[profile.id] = profile;
        }

        return result;
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
