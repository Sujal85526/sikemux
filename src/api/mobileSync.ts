import { invoke } from "@tauri-apps/api/core";

export interface MobileSyncStatus {
    running: boolean;
    bind: string | null;
    addr: string | null;
    baseUrl: string | null;
    websocketUrl: string | null;
}

export interface MobileSyncPairingInfo {
    token: string;
    running: boolean;
    baseUrl: string | null;
    websocketUrl: string | null;
}

export interface MobileSyncPairingQr {
    payload: string;
    svg: string;
}

export const mobileSyncApi = {
    start: (bind?: string): Promise<MobileSyncStatus> => invoke("mobile_sync_start", { bind: bind || null }),
    stop: (): Promise<MobileSyncStatus> => invoke("mobile_sync_stop"),
    status: (): Promise<MobileSyncStatus> => invoke("mobile_sync_status"),
    pairingInfo: (): Promise<MobileSyncPairingInfo> => invoke("mobile_sync_pairing_info"),
    pairingQr: (publicUrl?: string): Promise<MobileSyncPairingQr> => invoke("mobile_sync_pairing_qr", { publicUrl: publicUrl || null }),
};
