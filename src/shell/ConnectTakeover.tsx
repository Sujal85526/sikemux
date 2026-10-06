import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AccountAvatar } from "../account/AccountAvatar";
import { useAccount } from "../account/account";
import type { DeviceAccess, PendingDevice } from "../api/remote";
import { ACCESS_OPTIONS } from "../remote/access";
import { IconCommand, IconEye, IconLaptop, IconPhone } from "../ui/Icons";
import "../styles/connect-takeover.css";

const ACCESS_ICONS: Record<DeviceAccess, typeof IconCommand> = { full: IconCommand, watch: IconEye };

/** `1:52`, how long the phone still waits. */
export function waitsLabel(expiresAt: number, now: number): string {
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

/** Everything else on the page stops taking clicks and focus until the question is answered. */
function useInertBesides(host: HTMLElement | null) {
    useEffect(() => {
        if (!host) return;
        const others = [...document.body.children].filter(
            (element): element is HTMLElement => element instanceof HTMLElement && element !== host && !element.inert,
        );
        for (const element of others) element.inert = true;
        return () => {
            for (const element of others) element.inert = false;
        };
    }, [host]);
}

/**
 * The question a phone joining from the account asks, over the whole window: the app goes behind
 * the window's own ground until the person allows or declines it.
 */
export default function ConnectTakeover({
    request,
    onAnswer,
}: {
    request: PendingDevice;
    onAnswer: (allow: boolean, access: DeviceAccess) => Promise<void>;
}) {
    const account = useAccount((s) => s.account);
    const [access, setAccess] = useState<DeviceAccess>("full");
    const [host, setHost] = useState<HTMLElement | null>(null);
    const answered = useRef(false);
    const now = useNow();
    const name = request.name || "A phone";
    const title = `${name} wants to connect to this computer`;

    useEffect(() => {
        const element = document.createElement("div");
        element.className = "connect-takeover-host";
        document.body.append(element);
        setHost(element);
        return () => element.remove();
    }, []);
    useInertBesides(host);

    const answer = (allow: boolean) => {
        if (answered.current) return;
        answered.current = true;
        void onAnswer(allow, access).finally(() => (answered.current = false));
    };
    const answerRef = useRef(answer);
    answerRef.current = answer;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            event.stopImmediatePropagation();
            const onButton = event.target instanceof HTMLButtonElement && host?.contains(event.target);
            if (event.key === "Escape") {
                event.preventDefault();
                answerRef.current(false);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                setAccess((current) => (current === "full" ? "watch" : "full"));
            } else if (event.key === "Enter" && !onButton) {
                event.preventDefault();
                answerRef.current(true);
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, [host]);

    if (!host) return null;
    return createPortal(
        <div className="connect-takeover" role="alertdialog" aria-modal="true" aria-label={title} data-tauri-drag-region>
            <div className="connect-ground" aria-hidden="true" data-tauri-drag-region />
            <div className="connect-column">
                <div className="connect-handshake" aria-hidden="true">
                    <span className="connect-glow" />
                    <span className="connect-tile connect-tile-phone">
                        <IconPhone size={36} />
                    </span>
                    <span className="connect-line" />
                    <span className="connect-tile">
                        <IconLaptop size={36} />
                    </span>
                </div>
                <h2 className="connect-title">
                    {name} wants to connect
                    <br />
                    to this computer
                </h2>
                {account?.signedIn && (
                    <p className="connect-who">
                        <AccountAvatar account={account} className="connect-avatar" />
                        Signed in as <b>{account.email ?? account.name}</b>
                    </p>
                )}
                <div className="connect-choices" role="radiogroup" aria-label="Access for this phone">
                    {ACCESS_OPTIONS.map((option) => {
                        const Icon = ACCESS_ICONS[option.value];
                        return (
                            <button
                                key={option.value}
                                className="connect-choice"
                                type="button"
                                role="radio"
                                aria-checked={access === option.value}
                                onClick={() => setAccess(option.value)}>
                                <span className="connect-choice-mark">
                                    <Icon size={16} />
                                </span>
                                <span className="connect-choice-copy">
                                    <span className="connect-choice-label">{option.label}</span>
                                    <span className="connect-choice-detail">{option.detail}</span>
                                </span>
                                <span className="connect-radio" aria-hidden="true" />
                            </button>
                        );
                    })}
                </div>
                <div className="connect-actions">
                    <span className="connect-waits">waits {waitsLabel(request.expiresAt, now)}</span>
                    <button className="connect-btn" type="button" onClick={() => answer(false)}>
                        Decline
                    </button>
                    <button className="connect-btn connect-allow" type="button" onClick={() => answer(true)}>
                        Allow
                    </button>
                </div>
                <div className="connect-hints" aria-hidden="true">
                    <span>
                        <kbd>esc</kbd>Decline
                    </span>
                    <span>
                        <kbd>↑↓</kbd>Choose access
                    </span>
                    <span>
                        <kbd>↩</kbd>Allow
                    </span>
                </div>
            </div>
            <p className="connect-foot">Only allow phones you own. Remove one any time in Settings › Devices.</p>
        </div>,
        host,
    );
}
