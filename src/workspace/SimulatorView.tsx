import { useEffect, useRef, useState } from "react";
import { frameUrl, simulatorApi, type SimulatorInput, type SimulatorScreen } from "../api/simulator";
import type { DeskSimulator } from "../state/types";
import { reportError } from "../state/toast";
import { IconHome, IconLock } from "../ui/Icons";

/** A press that moves less than this, in window pixels, is a tap rather than a swipe. */
const TAP_SLOP = 6;
const LONG_PRESS_SECONDS = 0.5;

interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Where a point in the window lands on the device, in points, or null when it
 * misses the screen. The screen is drawn at its own aspect ratio, centred in
 * `stage`, so any margins around it are not part of it.
 */
export function toDevicePoint(stage: Box, screen: SimulatorScreen, clientX: number, clientY: number): { x: number; y: number } | null {
    const scale = Math.min(stage.width / screen.width, stage.height / screen.height);
    if (!(scale > 0)) return null;
    const left = stage.left + (stage.width - screen.width * scale) / 2;
    const top = stage.top + (stage.height - screen.height * scale) / 2;
    const x = (clientX - left) / scale;
    const y = (clientY - top) / scale;
    if (x < 0 || y < 0 || x > screen.width || y > screen.height) return null;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** The text a key types on the simulator, or null for keys it leaves to Sikemux. */
export function typedText(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): string | null {
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    if (event.key === "Enter") return "\n";
    if (event.key === "Tab") return "\t";
    if (event.key === "Backspace") return "\b";
    return [...event.key].length === 1 ? event.key : null;
}

export function SimulatorView({ simulator, live }: { simulator: DeskSimulator; live: boolean }) {
    const { udid, screen } = simulator;
    const [frame, setFrame] = useState<number | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const image = useRef<HTMLImageElement>(null);
    const press = useRef<{ x: number; y: number; clientX: number; clientY: number; at: number } | null>(null);

    /* The stream runs only while this tab is on screen, so a desk in the
       background costs the simulator nothing. */
    useEffect(() => {
        if (!live) return;
        const controller = new AbortController();
        setFailure(null);
        void simulatorApi
            .subscribeFrames((event) => {
                if (event.udid !== udid) return;
                if (event.error) setFailure(event.error);
                else if (event.frame !== undefined) setFrame(event.frame);
            }, controller.signal)
            .catch(() => {});
        void simulatorApi.openView(udid).catch((error) => setFailure(String(error)));
        return () => {
            controller.abort();
            void simulatorApi.closeView(udid).catch(() => {});
        };
    }, [live, udid]);

    const send = (input: SimulatorInput) => void simulatorApi.input(udid, input).catch(reportError("control the simulator"));

    const pointAt = (clientX: number, clientY: number) => {
        const box = image.current?.getBoundingClientRect();
        return box && screen ? toDevicePoint(box, screen, clientX, clientY) : null;
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const point = pointAt(event.clientX, event.clientY);
        if (!point || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        press.current = { ...point, clientX: event.clientX, clientY: event.clientY, at: performance.now() };
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        const start = press.current;
        press.current = null;
        if (!start) return;
        const seconds = (performance.now() - start.at) / 1000;
        const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
        if (moved < TAP_SLOP) {
            send({ type: "tap", x: start.x, y: start.y, ...(seconds >= LONG_PRESS_SECONDS ? { duration: seconds } : {}) });
            return;
        }
        const end = pointAt(event.clientX, event.clientY);
        if (!end) return;
        send({ type: "swipe", fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, duration: Math.min(Math.max(seconds, 0.05), 2) });
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const text = typedText(event);
        if (text === null) return;
        event.preventDefault();
        send({ type: "type", text });
    };

    const label = `${simulator.name} (${simulator.os})`;
    return (
        <div className="desk-simulator">
            <div className="simulator-toolbar">
                <span className="simulator-device" title={udid}>
                    {label}
                </span>
                <button type="button" aria-label="Home" title="Home" onClick={() => send({ type: "button", button: "home" })}>
                    <IconHome size={13} />
                </button>
                <button type="button" aria-label="Lock" title="Lock" onClick={() => send({ type: "button", button: "lock" })}>
                    <IconLock size={13} />
                </button>
            </div>
            <div
                className="simulator-stage"
                tabIndex={0}
                role="application"
                aria-label={`${label} screen. Click to tap, drag to swipe, type to enter text.`}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={() => (press.current = null)}
                onKeyDown={onKeyDown}>
                {failure ? (
                    <p className="simulator-status">The simulator view stopped: {failure}</p>
                ) : frame === null ? (
                    <p className="simulator-status">Connecting to {simulator.name}…</p>
                ) : (
                    <img ref={image} className="simulator-screen" src={frameUrl(udid, frame)} alt={`${label} screen`} draggable={false} />
                )}
            </div>
        </div>
    );
}
