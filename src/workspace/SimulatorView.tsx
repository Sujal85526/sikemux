import { useEffect, useMemo, useRef, useState } from "react";
import { frameUrl, simulatorApi, type SimulatorDevice, type SimulatorInput, type SimulatorScreen } from "../api/simulator";
import * as cmd from "../state/commands";
import { simulatorKey } from "../state/desks";
import type { DeskSimulator } from "../state/types";
import { reportError } from "../state/toast";
import { Dropdown, type DropdownOption } from "../ui/Dropdown";
import { IconHome, IconLock, IconStop } from "../ui/Icons";

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

const osVersion = (os: string) => (os.split(" ").pop() ?? "").split(".").map(Number);

/** Devices to pick from: the newest iOS first, then by name, with the ones already running marked. */
export function devicePickerOptions(devices: readonly SimulatorDevice[]): DropdownOption[] {
    return [...devices]
        .sort((a, b) => {
            const [newer, older] = [osVersion(a.os), osVersion(b.os)];
            for (let at = 0; at < Math.max(newer.length, older.length); at++) {
                const difference = (older[at] ?? 0) - (newer[at] ?? 0);
                if (difference) return difference;
            }
            return a.name.localeCompare(b.name, undefined, { numeric: true });
        })
        .map((device) => ({ value: device.udid, label: device.name, detail: device.booted ? `${device.os} · running` : device.os }));
}

export function SimulatorView({ agentId, simulator, hidden, live }: { agentId: string; simulator: DeskSimulator; hidden?: boolean; live: boolean }) {
    const { udid, screen } = simulator;
    const [devices, setDevices] = useState<SimulatorDevice[]>([]);
    const [booting, setBooting] = useState<string | null>(null);
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

    useEffect(() => {
        if (!live) return;
        let current = true;
        void simulatorApi
            .devices()
            .then((found) => current && setDevices(found))
            .catch(() => {});
        return () => {
            current = false;
        };
    }, [live]);

    const options = useMemo(
        () => devicePickerOptions(devices.some((device) => device.udid === udid) ? devices : [...devices, { ...simulator, booted: true }]),
        [devices, simulator, udid],
    );

    /* The agent moves to the picked device too, so the person and the agent
       keep looking at the same screen. */
    const pick = (next: string) => {
        if (next === udid) return;
        setBooting(devices.find((device) => device.udid === next)?.name ?? "the simulator");
        void simulatorApi
            .attach(agentId, next)
            .then(({ udid: picked, name, os, screen: size }) => cmd.switchDeskSimulator(agentId, udid, { udid: picked, name, os, screen: size }))
            .catch((error) => {
                setBooting(null);
                reportError("switch the simulator")(error);
            });
    };

    const shutDown = () =>
        void simulatorApi
            .shutdown(udid)
            .then(() => cmd.closeDeskItem(agentId, { key: simulatorKey(udid), kind: "simulator", simulator }))
            .catch(reportError("shut down the simulator"));

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
        <div className="desk-simulator" hidden={hidden}>
            <div className="simulator-toolbar">
                <Dropdown
                    className="simulator-picker"
                    value={udid}
                    options={options}
                    onChange={pick}
                    title="Simulator"
                    label={`Simulator: ${label}`}
                    search="Find a device"
                    menuWidth={280}
                />
                <span className="simulator-device">{simulator.os}</span>
                <button type="button" aria-label="Home" title="Home" onClick={() => send({ type: "button", button: "home" })}>
                    <IconHome size={13} />
                </button>
                <button type="button" aria-label="Lock" title="Lock" onClick={() => send({ type: "button", button: "lock" })}>
                    <IconLock size={13} />
                </button>
                <button type="button" aria-label="Shut down" title="Shut down" onClick={shutDown}>
                    <IconStop size={13} />
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
                {booting ? (
                    <p className="simulator-status">Booting {booting}…</p>
                ) : failure ? (
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
