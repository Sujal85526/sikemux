import { invokeCommand as invoke } from "./invoke";
import type { ReleaseNotes } from "../state/types";

export const releasesApi = {
    notes: (version: string) => invoke<ReleaseNotes>("release_notes", { version }),
    avatars: (urls: string[]) => invoke<Record<string, string>>("release_avatars", { urls }),
};

export const openInBrowser = (url: string) => invoke<void>("open_url", { url, app: null, shortcut: null });
