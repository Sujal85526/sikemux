import { invokeCommand as invoke } from "./invoke";

export interface SshHost {
    alias: string;
    hostname: string | null;
    user: string | null;
    port: number | null;
}

export const sshApi = {
    hosts: (): Promise<SshHost[]> => invoke<SshHost[]>("ssh_hosts"),
    configEnsure: (): Promise<string> => invoke<string>("ssh_config_ensure"),
};
