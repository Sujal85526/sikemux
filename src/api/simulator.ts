import { invokeCommand as invoke } from "./invoke";
import { getIpcTransport } from "./transport";

export interface SimulatorScreen {
    width: number;
    height: number;
}

/** The simulator an agent attached, as `sim_attach` reports it. */
export interface SimulatorAttached {
    agentId: string;
    udid: string;
    name: string;
    os: string;
    screen: SimulatorScreen | null;
}

/** A new frame of a simulator's screen is ready at `frameUrl`, or its stream ended with `error`. */
export interface SimulatorFrame {
    udid: string;
    frame?: number;
    error?: string;
}

/** What the person does on the screen, in device points. */
export type SimulatorInput =
    | { type: "tap"; x: number; y: number; duration?: number }
    | { type: "swipe"; fromX: number; fromY: number; toX: number; toY: number; duration?: number }
    | { type: "button"; button: "home" | "lock" }
    | { type: "type"; text: string };

export const frameUrl = (udid: string, frame: number): string => `sim://localhost/${encodeURIComponent(udid)}/${frame}`;

export const simulatorApi = {
    openView: (udid: string) => invoke<void>("simulator_view_open", { udid }),
    closeView: (udid: string) => invoke<void>("simulator_view_close", { udid }),
    input: (udid: string, input: SimulatorInput) => invoke<void>("simulator_input", { udid, input }),
    subscribeFrames: (listener: (frame: SimulatorFrame) => void, signal: AbortSignal) =>
        getIpcTransport().subscribe<SimulatorFrame>("simulator-frame", (event) => listener(event.payload), { signal }),
    subscribeAttached: (listener: (attached: SimulatorAttached) => void, signal: AbortSignal) =>
        getIpcTransport().subscribe<SimulatorAttached>("simulator-attached", (event) => listener(event.payload), { signal }),
};
