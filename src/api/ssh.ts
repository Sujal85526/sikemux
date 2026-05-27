import { invoke } from "@tauri-apps/api/core";

export interface SshHost {
    alias: string;
    hostname: string | null;
    user: string | null;
    port: number | null;
}

let cached: SshHost[] | null = null;
let inflight: Promise<SshHost[]> | null = null;

export const sshApi = {
    /** ~/.ssh/config hosts. Cached in-memory after the first call. */
    hosts: (): Promise<SshHost[]> => {
        if (cached) return Promise.resolve(cached);
        if (inflight) return inflight;
        inflight = invoke<SshHost[]>("ssh_hosts")
            .then((list) => {
                cached = list;
                return list;
            })
            .finally(() => {
                inflight = null;
            });
        return inflight;
    },
    invalidate: () => {
        cached = null;
    },
};
