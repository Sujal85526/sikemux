import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { simApi, type SimDevice, type SimOrientation, type SimScreen, type SimStreamFormat } from "../api/sim";
import { AGENT_NAMES } from "../agents/agentLaunch";
import { readClipboardText } from "../lib/clipboard";
import { basename } from "../lib/paths";
import * as cmd from "../state/commands";
import { confirmDialog } from "../state/dialog";
import { useSimulatorActing, useSimulatorAttachments } from "../state/simulatorAgents";
import { getState, useStore } from "../state/store";
import type { DeskSimulator } from "../state/types";
import { notify, reportError } from "../state/toast";
import { Dropdown } from "../ui/Dropdown";
import { EmptyState } from "../ui/Panel";
import { useDocumentVisible } from "./documentVisible";
import { playScreen, type ScreenPlayer } from "./screenStream";
import { loadSimStatus, prepareSim, simUsable, useSimStatus } from "./simStatus";
import "../styles/simulator.css";

const NAMED_KEYS = new Set(["Enter", "Escape", "Backspace", "Delete", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]);
const TURNS: SimOrientation[] = ["portrait", "landscapeLeft", "portraitUpsideDown", "landscapeRight"];
const REFRESH_MS = 5000;
const WHEEL_SETTLE_MS = 80;
const SWIPE_STEPS = 6;

export interface Point {
    x: number;
    y: number;
}

export interface CanvasBox {
    width: number;
    height: number;
    rect: { left: number; top: number; width: number; height: number };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isIosDevice = (device: SimDevice): boolean => /^(iOS|iPadOS)\b/.test(device.runtime);

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** The screen's size in points as the frames show it, which is always upright. */
function uprightSize(screen: SimScreen): { width: number; height: number } {
    return screen.orientation.startsWith("landscape") ? { width: screen.height, height: screen.width } : screen;
}

/** Where a pointer is on the upright frame, in points, and how many points one CSS pixel covers. */
function uprightPoint(canvas: CanvasBox, screen: SimScreen, clientX: number, clientY: number): Point & { scale: number } {
    const upright = uprightSize(screen);
    const fit = Math.min(canvas.rect.width / canvas.width, canvas.rect.height / canvas.height);
    const left = canvas.rect.left + (canvas.rect.width - canvas.width * fit) / 2;
    const top = canvas.rect.top + (canvas.rect.height - canvas.height * fit) / 2;
    const scale = upright.width / (canvas.width * fit);
    return { x: (clientX - left) * scale, y: (clientY - top) * scale, scale };
}

/** The frames stay upright while the device turns, so a point on them is turned to the device's own points. */
export function turnPoint(point: Point, screen: SimScreen): Point {
    const { width, height } = uprightSize(screen);
    switch (screen.orientation) {
        case "landscapeLeft":
            return { x: point.y, y: width - point.x };
        case "landscapeRight":
            return { x: height - point.y, y: point.x };
        case "portraitUpsideDown":
            return { x: width - point.x, y: height - point.y };
        default:
            return point;
    }
}

/** Where a pointer is on the device, in points. Off the screen it is null, or the nearest edge when clamped. */
export function devicePoint(canvas: CanvasBox, screen: SimScreen, clientX: number, clientY: number, opts: { clamp?: boolean } = {}): Point | null {
    if (!canvas.width || !canvas.height) return null;
    const { width, height } = uprightSize(screen);
    const { x, y } = uprightPoint(canvas, screen, clientX, clientY);
    if (opts.clamp) return turnPoint({ x: clamp(x, width), y: clamp(y, height) }, screen);
    return x < 0 || y < 0 || x > width || y > height ? null : turnPoint({ x, y }, screen);
}

/** A finger drawn from under the pointer the way a scroll of `dx`, `dy` pixels moves the page, kept on the screen. */
export function scrollSwipe(canvas: CanvasBox, screen: SimScreen, clientX: number, clientY: number, dx: number, dy: number): Point[] {
    const { width, height } = uprightSize(screen);
    const start = uprightPoint(canvas, screen, clientX, clientY);
    const end = { x: clamp(start.x - dx * start.scale, width), y: clamp(start.y - dy * start.scale, height) };
    return Array.from({ length: SWIPE_STEPS + 1 }, (_, step) =>
        turnPoint({ x: start.x + ((end.x - start.x) * step) / SWIPE_STEPS, y: start.y + ((end.y - start.y) * step) / SWIPE_STEPS }, screen),
    );
}

export function keyForDevice(event: { key: string; metaKey: boolean; ctrlKey: boolean }): { key: string } | { text: string } | null {
    if (event.metaKey || event.ctrlKey) return null;
    if (NAMED_KEYS.has(event.key)) return { key: event.key };
    return [...event.key].length === 1 ? { text: event.key } : null;
}

function deviceDetail(device: SimDevice, heldByProject: string | undefined): string {
    const running = device.state === "booted" ? " · running" : "";
    const held = heldByProject ? ` · In use by ${basename(heldByProject)}` : "";
    return `${device.runtime}${running}${held}`;
}

export function screenshotPath(deviceName: string, at: Date): string {
    const name =
        deviceName
            .replace(/[^\p{L}\p{N} ._()-]+/gu, "-")
            .replace(/^[\s.-]+/, "")
            .trim() || "Device";
    const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `~/Desktop/Simulator ${name} ${stamp}.png`;
}

interface Gesture {
    pointerId: number;
    rect: DOMRect;
    last: Point;
}

interface Scroll {
    clientX: number;
    clientY: number;
    canvas: CanvasBox;
    dx: number;
    dy: number;
    timer: number;
}

const canvasBox = (canvas: HTMLCanvasElement, rect: DOMRect): CanvasBox => ({ width: canvas.width, height: canvas.height, rect });

export function SimulatorPane({ agentId, simulator, visible }: { agentId: string; simulator: DeskSimulator; visible: boolean }) {
    const status = useSimStatus();
    const [statusProblem, setStatusProblem] = useState<string | null>(null);
    const [prepare, setPrepare] = useState<{ fraction: number } | { error: string } | null>(null);
    const [prepareAttempt, setPrepareAttempt] = useState(0);
    const [devices, setDevices] = useState<SimDevice[] | null>(null);
    const [listProblem, setListProblem] = useState<string | null>(null);
    const [streamProblem, setStreamProblem] = useState<string | null>(null);
    const [actionProblem, setActionProblem] = useState<string | null>(null);
    const [power, setPower] = useState<"booting" | "shuttingDown" | null>(null);
    const [screen, setScreen] = useState<SimScreen | null>(null);
    const [framed, setFramed] = useState(false);
    const [fps, setFps] = useState(0);
    const [format, setFormat] = useState<SimStreamFormat>("h264");
    const [latency, setLatency] = useState<number | null>(null);
    const [screenAsked, setScreenAsked] = useState(0);
    const [streamEnded, setStreamEnded] = useState(false);
    const [streamAttempt, setStreamAttempt] = useState(0);
    const player = useRef<ScreenPlayer | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // Input goes out in the order it happened; the helper answers requests in parallel.
    const input = useRef<Promise<unknown>>(Promise.resolve());
    const gesture = useRef<Gesture | null>(null);
    const pendingMove = useRef<Point | null>(null);
    const scroll = useRef<Scroll | null>(null);
    const latest = useRef(simulator);
    latest.current = simulator;

    const documentVisible = useDocumentVisible();
    const shown = visible && documentVisible;
    const usable = simUsable(status);
    const installed = !!status?.installed;
    const device = devices?.find((candidate) => candidate.udid === simulator.udid) ?? null;
    const udid = device?.udid ?? null;
    const booted = device?.state === "booted";
    const starting = power === "booting" || device?.state === "busy";
    const agentType = useStore((state) => state.agents[agentId]?.type);
    const agentName = agentType ? AGENT_NAMES[agentType] : "The agent";
    const attachments = useSimulatorAttachments();
    const acting = useSimulatorActing(agentId);
    const ownDevice = attachments[agentId] ?? null;
    const heldBy = (target: string) =>
        Object.values(attachments).find((attachment) => attachment.udid === target && attachment.agentId !== agentId) ?? null;

    const refresh = useCallback(async () => {
        try {
            const list = (await simApi.devices()).filter(isIosDevice);
            setDevices(list);
            setListProblem(null);
            const { id, udid: showing, deviceName } = latest.current;
            const current = list.find((candidate) => candidate.udid === showing);
            const pick =
                current ?? list.find((candidate) => candidate.state === "booted") ?? list.find((candidate) => candidate.name.startsWith("iPhone"));
            if (pick && (pick.udid !== showing || pick.name !== deviceName))
                cmd.setDeskSimulatorDevice(agentId, id, { udid: pick.udid, name: pick.name });
        } catch (error) {
            setListProblem(message(error));
        }
    }, [agentId]);

    useEffect(() => {
        if (status || statusProblem) return;
        let alive = true;
        loadSimStatus().then(
            () => alive && setStatusProblem(null),
            (error: unknown) => alive && setStatusProblem(message(error)),
        );
        return () => {
            alive = false;
        };
    }, [status, statusProblem]);

    useEffect(() => {
        if (!usable || installed || !shown) return;
        let alive = true;
        const controller = new AbortController();
        void simApi.subscribe((event) => alive && setPrepare({ fraction: event.fraction }), controller.signal).catch(() => {});
        setPrepare({ fraction: 0 });
        prepareSim().then(
            () => alive && setPrepare(null),
            (error: unknown) => alive && setPrepare({ error: message(error) }),
        );
        return () => {
            alive = false;
            controller.abort();
        };
    }, [usable, installed, shown, prepareAttempt]);

    const ready = usable && installed;
    useEffect(() => {
        if (!ready || !shown) return;
        void refresh();
        const timer = window.setInterval(() => void refresh(), REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [ready, shown, refresh]);

    useEffect(() => {
        if (!ready) return;
        const controller = new AbortController();
        void simApi
            .subscribeAttached((attached) => {
                if (attached.agentId === agentId) void refresh();
            }, controller.signal)
            .catch(() => {});
        return () => controller.abort();
    }, [ready, agentId, refresh]);

    useEffect(() => {
        if (!udid || !booted) return setScreen(null);
        let alive = true;
        void simApi.screen(udid).then((next) => alive && setScreen(next), reportError("simulator screen size"));
        return () => {
            alive = false;
        };
    }, [udid, booted, screenAsked]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!udid || !booted || !shown || !canvas) return;
        setStreamProblem(null);
        setStreamEnded(false);
        const playing = playScreen(udid, canvas, {
            onError: setStreamProblem,
            onFirstFrame: () => setFramed(true),
            onEnded: () => {
                setStreamEnded(true);
                void refresh();
            },
            ...(import.meta.env.DEV ? { onFps: setFps, onFormat: setFormat, onLatency: setLatency } : {}),
        });
        player.current = playing;
        return () => {
            playing.stop();
            player.current = null;
        };
    }, [udid, booted, shown, streamAttempt, refresh]);

    useEffect(() => setFramed(false), [udid, booted]);

    useEffect(() => {
        const current = gesture.current;
        if (!acting || !current || !udid) return;
        gesture.current = null;
        input.current = input.current.then(() => simApi.touch(udid, "up", current.last.x, current.last.y)).catch(reportError("simulator input"));
    }, [acting, udid]);

    const send = (work: () => Promise<unknown>) => {
        input.current = input.current.then(work).catch(reportError("simulator input"));
    };
    const action = (work: () => Promise<unknown>) => {
        setActionProblem(null);
        send(work);
    };

    const queueMove = (target: string, point: Point) => {
        const waiting = pendingMove.current !== null;
        pendingMove.current = point;
        if (waiting) return;
        send(() => {
            const next = pendingMove.current;
            pendingMove.current = null;
            return next ? simApi.touch(target, "move", next.x, next.y) : Promise.resolve();
        });
    };

    const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (!udid || !screen || !framed || acting || gesture.current || !event.isPrimary || event.button !== 0) return;
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const point = devicePoint(canvasBox(canvas, rect), screen, event.clientX, event.clientY);
        if (!point) return;
        canvas.setPointerCapture(event.pointerId);
        gesture.current = { pointerId: event.pointerId, rect, last: point };
        setActionProblem(null);
        player.current?.markInput();
        send(() => simApi.touch(udid, "down", point.x, point.y));
    };
    const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
        const current = gesture.current;
        if (!udid || !screen || !current || current.pointerId !== event.pointerId) return;
        const point = devicePoint(canvasBox(event.currentTarget, current.rect), screen, event.clientX, event.clientY, { clamp: true });
        if (!point) return;
        current.last = point;
        queueMove(udid, point);
    };
    const pointerEnd = (event: PointerEvent<HTMLCanvasElement>) => {
        const current = gesture.current;
        if (!udid || !current || current.pointerId !== event.pointerId) return;
        gesture.current = null;
        const lifted =
            event.type === "pointerup" && screen
                ? devicePoint(canvasBox(event.currentTarget, current.rect), screen, event.clientX, event.clientY, { clamp: true })
                : null;
        const point = lifted ?? current.last;
        send(() => simApi.touch(udid, "up", point.x, point.y));
    };

    const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
        if (!udid || !screen || !framed || acting || gesture.current) return;
        let current = scroll.current;
        if (!current) {
            const canvas = canvasBox(event.currentTarget, event.currentTarget.getBoundingClientRect());
            if (!devicePoint(canvas, screen, event.clientX, event.clientY)) return;
            current = scroll.current = { clientX: event.clientX, clientY: event.clientY, canvas, dx: 0, dy: 0, timer: 0 };
        }
        const lines = event.deltaMode === 1 ? 16 : 1;
        current.dx += event.deltaX * lines;
        current.dy += event.deltaY * lines;
        window.clearTimeout(current.timer);
        const settled = current;
        current.timer = window.setTimeout(() => {
            scroll.current = null;
            const path = scrollSwipe(settled.canvas, screen, settled.clientX, settled.clientY, settled.dx, settled.dy);
            player.current?.markInput();
            send(() => simApi.touch(udid, "down", path[0].x, path[0].y));
            for (const point of path.slice(1, -1)) send(() => simApi.touch(udid, "move", point.x, point.y));
            const end = path[path.length - 1];
            send(() => simApi.touch(udid, "up", end.x, end.y));
        }, WHEEL_SETTLE_MS);
    };
    useEffect(() => () => window.clearTimeout(scroll.current?.timer), []);

    const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
        if (!udid || acting) return;
        if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
            event.preventDefault();
            action(() => readClipboardText().then((text) => (text ? simApi.text(udid, text) : undefined)));
            return;
        }
        const press = keyForDevice(event);
        if (!press) return;
        event.preventDefault();
        action(() => ("key" in press ? simApi.key(udid, press.key) : simApi.text(udid, press.text)));
    };

    const togglePower = async () => {
        if (!udid || power || starting) return;
        setActionProblem(null);
        const holder = Object.values(attachments).find((attachment) => attachment.udid === udid);
        if (booted && holder) {
            const type = getState().agents[holder.agentId]?.type;
            const confirmed = await confirmDialog({
                title: `Shut down ${device?.name ?? "this device"}?`,
                body: `${type ? AGENT_NAMES[type] : "An agent"} is using this device.`,
                confirmLabel: "Shut down",
                destructive: true,
            });
            if (!confirmed) return;
        }
        setPower(booted ? "shuttingDown" : "booting");
        try {
            await (booted ? simApi.shutdown(udid) : simApi.boot(udid));
        } catch (error) {
            setActionProblem(message(error));
        } finally {
            setPower(null);
            await refresh();
        }
    };
    const rotate = () => {
        if (!udid) return;
        const turn = Math.max(
            0,
            TURNS.findIndex((orientation) => orientation === screen?.orientation),
        );
        const next = TURNS[(turn + 1) % TURNS.length];
        action(() => simApi.orientation(udid, next).then(() => setScreenAsked((asked) => asked + 1)));
    };
    const screenshot = () => {
        if (!udid || !device) return;
        const path = screenshotPath(device.name, new Date());
        action(() => simApi.screenshot(udid, path).then(() => notify("success", "Screenshot saved to the Desktop")));
    };

    if (statusProblem)
        return (
            <EmptyState
                title="iOS Simulator"
                message={statusProblem}
                tone="error"
                action={{ label: "Retry", onClick: () => setStatusProblem(null) }}
            />
        );
    if (status && !usable) return <EmptyState title="iOS Simulator" message={status.reason ?? "The iOS Simulator is not available here."} />;
    if (status && !installed) {
        if (prepare && "error" in prepare)
            return (
                <EmptyState
                    title="Could not get the simulator helper"
                    message={prepare.error}
                    tone="error"
                    action={{ label: "Retry", onClick: () => setPrepareAttempt((attempt) => attempt + 1) }}
                />
            );
        return <EmptyState title="Getting the simulator helper" message={`Downloading… ${Math.round((prepare?.fraction ?? 0) * 100)}%`} />;
    }
    if (listProblem && !devices)
        return <EmptyState title="iOS Simulator" message={listProblem} tone="error" action={{ label: "Retry", onClick: () => void refresh() }} />;
    if (devices && devices.length === 0)
        return <EmptyState title="No iOS simulators" message="Add an iOS runtime in Xcode › Settings › Components, then reopen this tab." />;

    const problem = actionProblem ?? streamProblem;
    return (
        <div className="sim-pane">
            <div className="sim-bar">
                <Dropdown
                    label="Device"
                    value={udid ?? ""}
                    options={(devices ?? []).map((candidate) => ({
                        value: candidate.udid,
                        label: candidate.name,
                        detail: deviceDetail(candidate, heldBy(candidate.udid)?.project),
                    }))}
                    onChange={(next) => {
                        const picked = devices?.find((candidate) => candidate.udid === next);
                        if (!picked) return;
                        cmd.setDeskSimulatorDevice(agentId, simulator.id, { udid: picked.udid, name: picked.name });
                        void simApi.setDeskDevice(agentId, picked.udid).catch(reportError("move the agent to that device"));
                    }}
                    disabled={!devices}
                />
                <button type="button" className="sim-chip" onClick={() => void togglePower()} disabled={!udid || !!power || starting}>
                    {starting ? "Booting…" : power === "shuttingDown" ? "Shutting down…" : booted ? "Shut down" : "Boot"}
                </button>
                <span className="sim-chips">
                    <button type="button" className="sim-chip" disabled={!booted} onClick={() => udid && action(() => simApi.button(udid, "home"))}>
                        Home
                    </button>
                    <button type="button" className="sim-chip" disabled={!booted} onClick={() => udid && action(() => simApi.button(udid, "lock"))}>
                        Lock
                    </button>
                    <button type="button" className="sim-chip" disabled={!booted} onClick={rotate}>
                        Rotate
                    </button>
                    <button type="button" className="sim-chip" disabled={!booted} onClick={screenshot}>
                        Screenshot
                    </button>
                </span>
                {import.meta.env.DEV && booted && shown && (
                    <span className="sim-fps" title="Frames drawn in the last second, the format, and the last tap → frame time (dev builds only)">
                        {fps} fps · {format === "h264" ? "H.264" : "MJPEG"}
                        {latency !== null && ` · tap→frame ${Math.round(latency)} ms`}
                    </span>
                )}
            </div>
            {ownDevice && ownDevice.udid !== simulator.udid && (
                <div className="sim-note">
                    <span>
                        {agentName} is on {ownDevice.name}
                    </span>
                    <button
                        type="button"
                        className="sim-chip"
                        onClick={() => cmd.setDeskSimulatorDevice(agentId, simulator.id, { udid: ownDevice.udid, name: ownDevice.name })}>
                        Show it
                    </button>
                </div>
            )}
            {problem && <div className="sim-problem">{problem}</div>}
            <div className="sim-stage">
                {booted ? (
                    <>
                        <canvas
                            ref={canvasRef}
                            className={`sim-screen${framed ? " framed" : ""}${acting ? " locked" : ""}`}
                            tabIndex={0}
                            data-takes-keys
                            aria-label={`${device?.name ?? "Simulator"} screen`}
                            onPointerDown={pointerDown}
                            onPointerMove={pointerMove}
                            onPointerUp={pointerEnd}
                            onPointerCancel={pointerEnd}
                            onLostPointerCapture={pointerEnd}
                            onWheel={wheel}
                            onKeyDown={keyDown}
                        />
                        {streamEnded ? (
                            <div className="sim-overlay">
                                <span>The screen stopped.</span>
                                <button type="button" className="sim-chip" onClick={() => setStreamAttempt((attempt) => attempt + 1)}>
                                    Reconnect
                                </button>
                            </div>
                        ) : (
                            acting && (
                                <div className="sim-overlay" role="status">
                                    {agentName} is using the device
                                </div>
                            )
                        )}
                    </>
                ) : starting ? (
                    <EmptyState icon={<span className="loading-ring" />} message={`Booting ${device?.name ?? "the device"}…`} />
                ) : (
                    <EmptyState
                        message={device ? `${device.name} is not running.` : "Pick a device."}
                        action={device ? { label: "Boot", onClick: () => void togglePower() } : undefined}
                    />
                )}
            </div>
        </div>
    );
}
