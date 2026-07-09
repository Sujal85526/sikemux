import { invoke } from "@tauri-apps/api/core";

export type BruBodyWire =
    | { kind: "none" }
    | { kind: "raw"; content_type: string | null; data: string }
    | { kind: "file"; path: string; content_type: string | null }
    | { kind: "form"; fields: [string, string][] }
    | { kind: "multipart"; fields: { name: string; value: string; is_file: boolean }[] };

export interface BruSendRequest {
    method: string;
    url: string;
    headers: [string, string][];
    body: BruBodyWire;
    timeout_ms: number;
    skip_tls_verify: boolean;
    trust: {
        allow_private_network: boolean;
        allow_file_read: boolean;
        allow_insecure_tls: boolean;
        file_root: string | null;
    };
}

export interface BruSendResponse {
    status: number;
    status_text: string;
    headers: [string, string][];
    body: string;
    is_binary: boolean;
    size_bytes: number;
    duration_ms: number;
}

export const brunoApi = {
    send: (req: BruSendRequest) => invoke<BruSendResponse>("bru_send", { req }),
};
