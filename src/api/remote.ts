import { invokeCommand as invoke } from "./invoke";
import { getIpcTransport } from "./transport";

export type DeviceAccess = "full" | "watch";

/** A phone or other machine approved to reach this Mac's terminals and agents. */
export interface PairedDevice {
    /** The device's public key. */
    readonly id: string;
    readonly name: string;
    readonly platform: string;
    readonly access: DeviceAccess;
    readonly pairedAt: number;
    readonly lastSeen: number | null;
}

export interface PairingOffer {
    readonly code: string;
    readonly expiresAt: number;
}

/** A device that typed the right code and waits for the person to answer. */
export interface PendingDevice {
    readonly id: string;
    readonly deviceId: string;
    /** What the device calls itself. Nothing vouches for it. */
    readonly name: string;
    readonly platform: string;
}

export interface RemoteStatus {
    readonly enabled: boolean;
    readonly coreId: string;
    readonly addresses: readonly string[];
    readonly devices: readonly PairedDevice[];
    readonly connected: readonly string[];
    readonly pairing: PairingOffer | null;
    readonly pending: readonly PendingDevice[];
}

/** A project a paired device may start an agent in. */
export interface PublishedProject {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}

/** One chat agent the app offers paired devices; the app works out how to run it. */
export interface LauncherRequest {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly configPath?: string;
    readonly executablePath?: string;
    readonly environmentKeys: readonly string[];
    readonly permissionMode: string;
}

export const REMOTE_STATUS_EVENT = "remote_status_changed";

export const remoteApi = {
    status: () => invoke<RemoteStatus>("remote_status"),
    setEnabled: (enabled: boolean) => invoke<RemoteStatus>("remote_set_enabled", { enabled }),
    setDeviceAccess: (id: string, access: DeviceAccess) => invoke<RemoteStatus>("remote_set_device_access", { id, access }),
    revokeDevice: (id: string) => invoke<RemoteStatus>("remote_revoke_device", { id }),
    openPairing: () => invoke<RemoteStatus>("remote_open_pairing"),
    closePairing: () => invoke<RemoteStatus>("remote_close_pairing"),
    answerPairing: (id: string, allow: boolean, access: DeviceAccess) => invoke<RemoteStatus>("remote_answer_pairing", { id, allow, access }),
    publishWorkspace: (projects: readonly PublishedProject[], launchers: readonly LauncherRequest[]) =>
        invoke<void>("remote_publish_workspace", { projects, launchers }),
    subscribe: (listener: (status: RemoteStatus) => void, signal: AbortSignal) =>
        getIpcTransport().subscribe<RemoteStatus>(REMOTE_STATUS_EVENT, (event) => listener(event.payload), { signal }),
};

/** The first eight characters of a key, enough to tell two devices apart by eye. */
export function shortKey(key: string): string {
    return key.slice(0, 8);
}

/** `482913` as `482 913`, the way people read a code aloud. */
export function spacedCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
