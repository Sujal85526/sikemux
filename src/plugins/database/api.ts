import { createPluginBackend, isPluginFailure } from "../../plugin-api/backend";
import { invalidate } from "../../plugin-api/resources";
import { DATABASE_PLUGIN_ID } from "./kinds";

const backend = createPluginBackend(DATABASE_PLUGIN_ID);

/** PostgreSQL's `sslmode` names: whether to encrypt, and whether to check the server's certificate. */
export type TlsMode = "disable" | "prefer" | "require" | "verify-full";

export interface PostgresTarget {
    engine: "postgres";
    host: string;
    port: number | null;
    database: string;
    user: string;
    tls: TlsMode;
}

export interface SqliteTarget {
    engine: "sqlite";
    path: string;
}

export type Target = PostgresTarget | SqliteTarget;
export type Engine = Target["engine"];

export type DatabaseProfile = Target & {
    id: string;
    name: string;
    readOnly: boolean;
    hasPassword: boolean;
};

/** A profile as the form holds it: no id until it is first saved. */
export type ProfileDraft = Target & {
    id?: string;
    name: string;
    readOnly: boolean;
};

export interface Tested {
    version: string;
    millis: number;
}

export interface Connected {
    id: string;
    version: string;
}

export function failureMessage(error: unknown): string {
    return isPluginFailure(error) ? error.message : String(error);
}

export const refreshDatabase = () => invalidate((kind) => kind.startsWith("database."));

export const databaseApi = {
    profiles: () => backend.call<DatabaseProfile[]>("profiles"),
    /** A password left out keeps the saved one; an empty one forgets it. */
    save: (profile: ProfileDraft, password?: string) => backend.call<DatabaseProfile>("save", { profile, password }),
    remove: (id: string) => backend.call<void>("remove", { id }),
    test: (profile: ProfileDraft, password?: string) => backend.call<Tested>("test", { profile, password }),
    connect: (id: string) => backend.call<Connected>("connect", { id }),
    disconnect: (id: string) => backend.call<void>("disconnect", { id }),
    connected: () => backend.call<Connected[]>("connected"),
};
