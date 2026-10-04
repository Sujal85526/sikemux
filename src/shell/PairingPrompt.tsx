import { lazy, Suspense, useEffect, useState } from "react";
import { remoteApi, type PendingDevice, type RemoteStatus } from "../api/remote";
import { useStore } from "../state/store";
import { reportError, swallow } from "../state/toast";

const PairingCards = lazy(() => import("./PairingCards"));

function usePendingDevices(): [readonly PendingDevice[], (next: Promise<RemoteStatus>) => Promise<void>] {
    const [pending, setPending] = useState<readonly PendingDevice[]>([]);
    useEffect(() => {
        const controller = new AbortController();
        const show = (status: RemoteStatus) => {
            if (!controller.signal.aborted) setPending(status.pending);
        };
        remoteApi
            .subscribe(show, controller.signal)
            .then(() => remoteApi.status())
            .then(show)
            .catch((error: unknown) => {
                if (!controller.signal.aborted) swallow("pairing requests")(error);
            });
        return () => controller.abort();
    }, []);
    const answer = async (next: Promise<RemoteStatus>) => {
        try {
            setPending((await next).pending);
        } catch (error) {
            reportError("Pairing")(error);
        }
    };
    return [pending, answer];
}

/**
 * Asks about a device waiting to pair or connect over whatever screen is up, since a phone
 * gives up after two minutes and the person is rarely on Settings › Devices when it asks.
 */
export function PairingPrompt() {
    const [pending, answer] = usePendingDevices();
    const devicesPageOpen = useStore((s) => s.settingsOpen && s.settingsPage === "devices");
    if (devicesPageOpen || pending.length === 0) return null;
    return (
        <Suspense fallback={null}>
            <PairingCards pending={pending} onAnswer={(id, allow, access) => void answer(remoteApi.answerPairing(id, allow, access))} />
        </Suspense>
    );
}
