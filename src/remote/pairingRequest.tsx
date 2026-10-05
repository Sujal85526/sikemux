import { useState } from "react";
import { shortKey, type DeviceAccess, type PendingDevice } from "../api/remote";
import { Dropdown } from "../ui/Dropdown";

export const ACCESS_OPTIONS = [
    { value: "full", label: "Full control", detail: "Drive terminals and agents" },
    { value: "watch", label: "Watch and approve", detail: "Read sessions and answer permission requests" },
];

const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android", macos: "macOS", linux: "Linux", web: "Web" };

export function platformName(platform: string): string {
    return PLATFORM_NAMES[platform] ?? platform;
}

/** What a waiting device is asking, in the words the person answers. */
export function pairingQuestion(request: PendingDevice): string {
    return request.fromAccount
        ? `${request.name || "A device"} from your Sikemux account wants to connect`
        : `${request.name || "Unnamed device"} wants to pair`;
}

export function PairingDetail({ request }: { request: PendingDevice }) {
    return (
        <>
            {platformName(request.platform)} · key <code className="device-key">{shortKey(request.deviceId)}</code> ·{" "}
            {request.fromAccount ? "signed in to your account" : "it typed the right code"}
        </>
    );
}

export function PairingAnswer({ className, onAnswer }: { className: string; onAnswer: (allow: boolean, access: DeviceAccess) => void }) {
    const [access, setAccess] = useState<DeviceAccess>("full");
    return (
        <div className={className}>
            <Dropdown
                className="settings-dd"
                label="access for this device"
                value={access}
                options={ACCESS_OPTIONS}
                onChange={(value) => setAccess(value as DeviceAccess)}
            />
            <button className="settings-btn" type="button" onClick={() => onAnswer(false, access)}>
                Decline
            </button>
            <button className="settings-btn primary" type="button" onClick={() => onAnswer(true, access)}>
                Allow
            </button>
        </div>
    );
}
