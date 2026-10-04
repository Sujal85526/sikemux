import { resource } from "../../plugin-api/resources";
import { databaseApi, type Connected, type DatabaseProfile } from "./api";

export const databaseProfilesR = resource({
    kind: "database.profiles",
    fetch: (): Promise<DatabaseProfile[]> => databaseApi.profiles(),
    staleAfterMs: 300_000,
});

export const databaseConnectedR = resource({
    kind: "database.connected",
    fetch: (): Promise<Connected[]> => databaseApi.connected(),
    staleAfterMs: 30_000,
});
