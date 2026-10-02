import { useEffect, useRef, useState } from "react";
import { frameUrl, simulatorApi, type SimulatorInput, type SimulatorScreen } from "../api/simulator";
import type { DeskSimulator } from "../state/types";
import { reportError } from "../state/toast";
import { IconHome, IconLock } from "../ui/Icons";

interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Where a point in the window lands on the device, in points, or null when it
 * misses the screen. The screen is drawn at its own aspect ratio, centred in
 * `stage`, so any margins around it are not part of it. With `clamp`, a point
 * off the screen lands on its nearest edge instead, as a finger dragged past
 * the side of a phone stays on the glass.
 */
export function toDevicePoint(stage: Box, screen: SimulatorScreen, clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
    const scale = Math.min(stage.width / screen.width, stage.height / screen.height);
    if (!(scale > 0)) return null;
    const left = stage.left + (stage.width - screen.width * scale) / 2;
    const top = stage.top + (stage.height - screen.height * scale) / 2;
    let x = (clientX - left) / scale;
    let y = (clientY - top) / scale;
    const outside = x < 0 || y < 0 || x > screen.width || y > screen.height;
    if (outside && !clamp) return null;
    x = Math.min(Math.max(x, 0), screen.width);
    y = Math.min(Math.max(y, 0), screen.height);
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
    const steps = useRef<Promise<void>>(Promise.resolve());
    const touching = useRef(false);
    const pendingMove = useRef<{ x: number; y: number } | null>(null);

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

    /* Each step waits for the one before, so the device sees a finger go down,
       move and lift in the order it did. */
    const inOrder = (next: () => Promise<void> | undefined) => {
        steps.current = steps.current.then(next).catch(reportError("control the simulator"));
    };
    const send = (input: SimulatorInput) => inOrder(() => simulatorApi.input(udid, input));

    const pointAt = (clientX: number, clientY: number, clamp = false) => {
        const box = image.current?.getBoundingClientRect();
        return box && screen ? toDevicePoint(box, screen, clientX, clientY, clamp) : null;
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const point = pointAt(event.clientX, event.clientY);
        if (!point || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        touching.current = true;
        send({ type: "touch", phase: "down", ...point });
    };

    /* Moves that arrive while an earlier step is still on its way fold into
       the latest one, so the device follows the finger without a backlog. */
    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!touching.current) return;
        const point = pointAt(event.clientX, event.clientY, true);
        if (!point) return;
        const queued = pendingMove.current !== null;
        pendingMove.current = point;
        if (queued) return;
        inOrder(() => {
            const latest = pendingMove.current;
            pendingMove.current = null;
            return latest ? simulatorApi.input(udid, { type: "touch", phase: "move", ...latest }) : undefined;
        });
    };

    const lift = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!touching.current) return;
        touching.current = false;
        const point = pointAt(event.clientX, event.clientY, true);
        if (point) send({ type: "touch", phase: "up", ...point });
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
                onPointerMove={onPointerMove}
                onPointerUp={lift}
                onPointerCancel={lift}
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
