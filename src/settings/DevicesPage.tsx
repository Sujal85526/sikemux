import { useEffect, useState } from "react";
import { accountApi } from "../api/account";
import { portsApi } from "../api/ports";
import { loadAccount, setAccount, useAccount } from "../account/account";
import {
    remoteApi,
    shortKey,
    type AccountLink,
    type DeviceAccess,
    type NotificationState,
    type PairedDevice,
    type PendingDevice,
    type RemoteStatus,
} from "../api/remote";
import { ACCESS_OPTIONS, PairingAnswer, PairingDetail, pairingQuestion, platformName } from "../remote/pairingRequest";
import { reportError } from "../state/toast";
import { Dropdown } from "../ui/Dropdown";
import { Switch } from "../ui/Controls";
import { IconTrash } from "../ui/Icons";
import { SettingsPage, SettingsRow, SettingsRows, SettingsSection } from "./SettingsLayout";

const DELETE_ACCOUNT_URL = import.meta.env.DEV ? "http://localhost:5173/delete-account" : "https://app.sikemux.com/delete-account";

/** How a phone's notifications from this host read beside its name, or nothing when it asked for none. */
export function notificationNote(state: NotificationState | undefined): string | null {
    switch (state) {
        case "on":
            return "notifications on";
        case "off":
            return "notifications off";
        case "phoneOff":
            return "notifications turned off on the phone";
        case "notReaching":
            return "notifications aren't reaching it";
        case "otherAccount":
            return "notifications need it signed in to your account";
        case "signedOut":
            return "sign in to send it notifications";
        default:
            return null;
    }
}

export function seenLabel(at: number | null, now: number): string {
    if (at === null) return "never connected";
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return "seen just now";
    if (minutes < 60) return `seen ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `seen ${hours} h ago`;
    return `seen ${new Date(at).toLocaleDateString()}`;
}

function useRemoteStatus(): [RemoteStatus | null, (next: Promise<RemoteStatus>, what: string) => Promise<void>] {
    const [status, setStatus] = useState<RemoteStatus | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        remoteApi
            .subscribe(setStatus, controller.signal)
            .then(() => remoteApi.status())
            .then((current) => {
                if (!controller.signal.aborted) setStatus(current);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) reportError("Remote access")(error);
            });
        return () => controller.abort();
    }, []);
    const apply = async (next: Promise<RemoteStatus>, what: string) => {
        try {
            setStatus(await next);
        } catch (error) {
            reportError(what)(error);
        }
    };
    return [status, apply];
}

export function DevicesPage() {
    const [status, apply] = useRemoteStatus();
    const now = Date.now();

    return (
        <SettingsPage>
            <SettingsSection
                title="Remote access"
                meta={status ? (status.enabled ? `${status.connected.length} connected` : "off") : "checking"}
                sub="Lets the devices you pair reach this host's terminals and agents. Connections are encrypted end to end and go direct when the network allows.">
                <SettingsRows>
                    <SettingsRow
                        label="Allow paired devices"
                        desc="While this is on, the background process keeps running after you quit and starts again when you log in, so your devices can always reach this host."
                        asLabel
                        control={
                            <Switch
                                checked={status?.enabled ?? false}
                                disabled={!status}
                                onChange={(enabled) => void apply(remoteApi.setEnabled(enabled), "Remote access")}
                                label="Allow paired devices"
                            />
                        }
                    />
                    {status?.coreId && (
                        <SettingsRow label="This host" desc="Your devices recognise this host by its key.">
                            <code className="device-key">{shortKey(status.coreId)}</code>
                        </SettingsRow>
                    )}
                </SettingsRows>
            </SettingsSection>

            <AccountSection link={status?.account ?? null} />

            {status?.pending.length ? (
                <SettingsSection title="Waiting to connect">
                    {status.pending.map((request) => (
                        <PendingRow
                            key={request.id}
                            request={request}
                            onAnswer={(allow, access) => void apply(remoteApi.answerPairing(request.id, allow, access), "Pairing")}
                        />
                    ))}
                </SettingsSection>
            ) : null}

            <SettingsSection title="Paired devices" meta={status ? `${status.devices.length} paired` : undefined}>
                {!status?.devices.length ? (
                    <div className="settings-empty">No devices yet. A device you pair stays paired until you revoke it here.</div>
                ) : (
                    <SettingsRows>
                        {status.devices.map((device) => (
                            <DeviceRow
                                key={device.id}
                                device={device}
                                connected={status.connected.includes(device.id)}
                                notifications={status.notifications.find((phone) => phone.deviceId === device.id)?.state}
                                now={now}
                                onAccess={(access) => void apply(remoteApi.setDeviceAccess(device.id, access), "Device access")}
                                onRevoke={() => void apply(remoteApi.revokeDevice(device.id), "Revoke device")}
                            />
                        ))}
                    </SettingsRows>
                )}
            </SettingsSection>
        </SettingsPage>
    );
}

/** How the live connection to the account reads in the section's corner. */
export function accountMeta(signedIn: boolean | undefined, link: AccountLink | null): string {
    if (signedIn === undefined) return "checking";
    if (!signedIn) return "signed out";
    if (link?.state === "connecting") return "connecting";
    if (link?.state === "offline") return "offline, retrying";
    return "signed in";
}

/** Why this host is signed out, when the account let it go rather than the person here. */
export function removalNote(link: AccountLink | null): string | null {
    if (link?.state !== "removed") return null;
    if (link.reason === "account_deleted") return "Your account was deleted. Devices already paired stay paired.";
    if (link.reason === "signed_out") return "This host was signed out of your account. Devices already paired stay paired.";
    return "This host was removed from your account at app.sikemux.com. Devices already paired stay paired.";
}

function AccountSection({ link }: { link: AccountLink | null }) {
    const account = useAccount((s) => s.account);
    const removed = removalNote(link);
    const [waiting, setWaiting] = useState(false);
    const [leaving, setLeaving] = useState(false);
    useEffect(() => {
        loadAccount().catch(reportError("Account"));
    }, []);
    useEffect(() => {
        if (removed && account?.signedIn) loadAccount().catch(reportError("Account"));
    }, [removed, account?.signedIn]);

    const signIn = async () => {
        setWaiting(true);
        try {
            setAccount(await accountApi.signIn());
        } catch (error) {
            if (!String(error).includes("cancelled")) reportError("Sign in")(error);
        } finally {
            setWaiting(false);
        }
    };
    const signOut = async () => {
        setLeaving(true);
        try {
            setAccount(await accountApi.signOut());
        } catch (error) {
            reportError("Sign out")(error);
        } finally {
            setLeaving(false);
        }
    };

    return (
        <SettingsSection
            title="Your account"
            meta={accountMeta(account?.signedIn, link)}
            sub="Devices signed in to the same Sikemux account find this host without a code. Each still needs your approval here before it can reach anything.">
            <SettingsRows>
                {account?.signedIn ? (
                    <SettingsRow
                        label={account.email ?? "Signed in"}
                        desc="Signing out takes this host off your account. Devices already paired stay paired.">
                        <span className="settings-actions">
                            <button
                                className="settings-btn"
                                type="button"
                                title="Delete your account at app.sikemux.com"
                                onClick={() => void portsApi.openExternal(DELETE_ACCOUNT_URL).catch(reportError("Open link"))}>
                                Delete account…
                            </button>
                            <button className="settings-btn" type="button" disabled={leaving} onClick={() => void signOut()}>
                                {leaving ? "Signing out…" : "Sign out"}
                            </button>
                        </span>
                    </SettingsRow>
                ) : waiting ? (
                    <SettingsRow label="Finish signing in in your browser" desc="Sikemux opened the sign-in page in your default browser.">
                        <button className="settings-btn" type="button" onClick={() => void accountApi.cancelSignIn()}>
                            Cancel
                        </button>
                    </SettingsRow>
                ) : (
                    <SettingsRow label="Not signed in" desc={removed ?? "Sign in with Google, GitHub or your email, in your browser."}>
                        <button className="settings-btn primary" type="button" disabled={!account} onClick={() => void signIn()}>
                            Sign in
                        </button>
                    </SettingsRow>
                )}
            </SettingsRows>
        </SettingsSection>
    );
}

function PendingRow({ request, onAnswer }: { request: PendingDevice; onAnswer: (allow: boolean, access: DeviceAccess) => void }) {
    const asking = pairingQuestion(request);
    return (
        <div className="pairing-request" role="group" aria-label={asking}>
            <span className="settings-row-copy">
                <span className="settings-row-label">{asking}</span>
                <span className="settings-row-desc">
                    <PairingDetail request={request} />
                </span>
            </span>
            <PairingAnswer className="settings-actions" onAnswer={onAnswer} />
        </div>
    );
}

function DeviceRow({
    device,
    connected,
    notifications,
    now,
    onAccess,
    onRevoke,
}: {
    device: PairedDevice;
    connected: boolean;
    notifications: NotificationState | undefined;
    now: number;
    onAccess: (access: DeviceAccess) => void;
    onRevoke: () => void;
}) {
    const note = notificationNote(notifications);
    const seen = connected ? "connected now" : seenLabel(device.lastSeen, now);
    return (
        <SettingsRow
            label={device.name || "Unnamed device"}
            desc={
                <>
                    {platformName(device.platform)} · {seen}
                    {note && (
                        <>
                            {" · "}
                            <span className={notifications === "notReaching" || notifications === "otherAccount" ? "device-warning" : undefined}>
                                {note}
                            </span>
                        </>
                    )}
                </>
            }>
            <span className="device-controls">
                <Dropdown
                    className="settings-dd"
                    label={`access for ${device.name}`}
                    value={device.access}
                    options={ACCESS_OPTIONS}
                    onChange={(value) => onAccess(value as DeviceAccess)}
                />
                <button className="settings-btn danger" type="button" onClick={onRevoke} title="Forget this device and end its connections">
                    <IconTrash size={12} /> Revoke
                </button>
            </span>
        </SettingsRow>
    );
}
