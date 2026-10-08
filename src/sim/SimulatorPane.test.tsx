import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simApi, type SimScreen } from "../api/sim";
import { noteSimulatorActing, noteSimulatorAttached, noteSimulatorDetached } from "../state/simulatorAgents";
import { playScreen } from "./screenStream";
import { deviceOptions, devicePoint, keyForDevice, screenshotPath, scrollSwipe, SimulatorPane } from "./SimulatorPane";

vi.mock("../api/sim", () => ({
    simApi: {
        status: vi.fn(),
        prepare: vi.fn(),
        subscribe: vi.fn(),
        devices: vi.fn(),
        screen: vi.fn(),
        touch: vi.fn(),
        text: vi.fn(),
        key: vi.fn(),
        boot: vi.fn(),
        shutdown: vi.fn(),
        subscribeAttached: vi.fn(),
        setDeskDevice: vi.fn(),
    },
}));

vi.mock("./screenStream", () => ({ playScreen: vi.fn() }));

const deviceScreen = { width: 402, height: 874, scale: 3, orientation: "portrait" as const };
/* A 1206 x 2622 frame drawn into a 600 x 600 box: scaled to fit its height and centred, with bars either side. */
const canvas = { width: 1206, height: 2622, rect: { left: 100, top: 50, width: 600, height: 600 } };
const drawnLeft = 100 + (600 - 1206 * (600 / 2622)) / 2;

describe("pointing at the simulator's screen", () => {
    it("finds the device point under the pointer, past the bars a contained canvas leaves", () => {
        expect(devicePoint(canvas, deviceScreen, drawnLeft, 50)).toEqual({ x: 0, y: 0 });
        const centre = devicePoint(canvas, deviceScreen, 400, 350)!;
        expect(centre.x).toBeCloseTo(201);
        expect(centre.y).toBeCloseTo(437);
    });

    it("ignores the bars beside the screen and a canvas with nothing drawn yet", () => {
        expect(devicePoint(canvas, deviceScreen, 105, 300)).toBeNull();
        expect(devicePoint({ ...canvas, width: 0, height: 0 }, deviceScreen, 400, 350)).toBeNull();
    });

    it("holds a dragged finger at the screen's edge", () => {
        expect(devicePoint(canvas, deviceScreen, 105, 700, { clamp: true })).toEqual({ x: 0, y: 874 });
    });

    it("turns a point on the upright picture into the points of a turned device", () => {
        const landscape = { width: 874, height: 402, scale: 3 };
        const corner = (orientation: SimScreen["orientation"], screenSize = landscape) =>
            devicePoint(canvas, { ...screenSize, orientation }, drawnLeft, 50);
        expect(corner("landscapeLeft")).toEqual({ x: 0, y: 402 });
        expect(corner("landscapeRight")).toEqual({ x: 874, y: 0 });
        expect(corner("portraitUpsideDown", { width: 402, height: 874, scale: 3 })).toEqual({ x: 402, y: 874 });

        const centre = devicePoint(canvas, { ...landscape, orientation: "landscapeLeft" }, 400, 350)!;
        expect(centre.x).toBeCloseTo(437);
        expect(centre.y).toBeCloseTo(201);
        expect(devicePoint(canvas, { ...landscape, orientation: "landscapeRight" }, 105, 700, { clamp: true })).toEqual({ x: 0, y: 0 });
    });

    it("scrolls by drawing a finger the other way, kept on the screen", () => {
        const path = scrollSwipe(canvas, deviceScreen, 400, 350, 0, 10_000);
        expect(path[0].x).toBeCloseTo(201);
        expect(path[0].y).toBeCloseTo(437);
        expect(path.at(-1)!.x).toBeCloseTo(201);
        expect(path.at(-1)!.y).toBe(0);
    });

    it("scrolls a turned device along the picture's own up and down", () => {
        const path = scrollSwipe(canvas, { width: 874, height: 402, scale: 3, orientation: "landscapeLeft" }, 400, 350, 0, 10_000);
        expect(path.at(-1)!.x).toBe(0);
        expect(path.at(-1)!.y).toBeCloseTo(201);
    });
});

describe("typing into the device", () => {
    it("sends what Option types, and leaves Command and Tab to the app", () => {
        expect(keyForDevice({ key: "å", metaKey: false, ctrlKey: false })).toEqual({ text: "å" });
        expect(keyForDevice({ key: "Enter", metaKey: false, ctrlKey: false })).toEqual({ key: "Enter" });
        expect(keyForDevice({ key: "c", metaKey: true, ctrlKey: false })).toBeNull();
        expect(keyForDevice({ key: "Tab", metaKey: false, ctrlKey: false })).toBeNull();
        expect(keyForDevice({ key: "Dead", metaKey: false, ctrlKey: false })).toBeNull();
    });

    it("names a screenshot with only what a file name can hold", () => {
        expect(screenshotPath("iPhone 17 / Pro: test", new Date("2026-10-08T01:02:03.456Z"))).toBe(
            "~/Desktop/Simulator iPhone 17 - Pro- test 2026-10-08T01-02-03.png",
        );
    });
});

describe("the simulator pane", () => {
    const simulator = { id: "sim-1", udid: "UDID-1", deviceName: "iPhone 17" };
    let firstFrame: () => void = () => {};

    beforeEach(() => {
        vi.mocked(simApi.status).mockResolvedValue({ supported: true, installed: true, reason: null });
        vi.mocked(simApi.devices).mockResolvedValue([
            { udid: "UDID-1", name: "iPhone 17", state: "booted", runtime: "iOS 26.0", model: "iPhone18,1" },
        ]);
        vi.mocked(simApi.screen).mockResolvedValue(deviceScreen);
        vi.mocked(simApi.touch).mockResolvedValue(undefined);
        vi.mocked(simApi.text).mockResolvedValue(undefined);
        vi.mocked(simApi.subscribeAttached).mockResolvedValue(() => {});
        vi.mocked(playScreen).mockImplementation((_udid, target, events) => {
            target.width = 1206;
            target.height = 2622;
            firstFrame = () => events.onFirstFrame?.();
            return { stop: vi.fn(), markInput: vi.fn() };
        });
        HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
        HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ ...canvas.rect, right: 700, bottom: 650, x: 100, y: 50, toJSON: () => ({}) });
    });

    afterEach(() => {
        cleanup();
        noteSimulatorDetached("agent-1");
        vi.clearAllMocks();
    });

    async function showScreen() {
        render(<SimulatorPane agentId="agent-1" simulator={simulator} visible />);
        const surface = await screen.findByLabelText("iPhone 17 screen");
        await waitFor(() => expect(playScreen).toHaveBeenCalled());
        await waitFor(() => expect(simApi.screen).toHaveBeenCalled());
        act(() => firstFrame());
        return surface;
    }

    const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
        ...extra,
    });

    it("marks its screen as somewhere keys go, so the app's own single-key shortcuts stay out", async () => {
        const surface = await showScreen();
        expect(surface).toHaveAttribute("data-takes-keys");
        fireEvent.keyDown(surface, { key: "å", altKey: true });
        await waitFor(() => expect(simApi.text).toHaveBeenCalledWith("UDID-1", "å"));
    });

    it("sends only the latest of the moves that pile up behind one in flight", async () => {
        let release: () => void = () => {};
        vi.mocked(simApi.touch).mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(undefined))));
        const surface = await showScreen();

        fireEvent.pointerDown(surface, pointer(400, 350));
        fireEvent.pointerMove(surface, pointer(400, 360));
        fireEvent.pointerMove(surface, pointer(400, 370));
        fireEvent.pointerMove(surface, pointer(400, 380));
        fireEvent.pointerUp(surface, pointer(400, 380));
        await waitFor(() => expect(simApi.touch).toHaveBeenCalledTimes(1));
        await act(async () => release());

        await waitFor(() => expect(vi.mocked(simApi.touch).mock.calls.map((call) => call[1])).toEqual(["down", "move", "up"]));
        expect(vi.mocked(simApi.touch).mock.calls[1][3]).toBeCloseTo(((380 - 50) / 600) * 874);
    });

    it("lifts the finger when the pointer is taken away, and ignores moves with no finger down", async () => {
        const surface = await showScreen();

        fireEvent.pointerMove(surface, pointer(400, 360));
        fireEvent.pointerDown(surface, pointer(400, 350, { button: 2 }));
        fireEvent.pointerDown(surface, pointer(400, 350));
        fireEvent.pointerMove(surface, pointer(900, 360));
        fireEvent.pointerCancel(surface, pointer(900, 360));
        fireEvent.lostPointerCapture(surface, pointer(900, 360));

        await waitFor(() => expect(vi.mocked(simApi.touch).mock.calls.map((call) => call[1])).toEqual(["down", "move", "up"]));
        const [, , upX] = vi.mocked(simApi.touch).mock.calls[2];
        expect(upX).toBe(402);
    });

    it("keeps the person's hands off the device while the agent drives it", async () => {
        const surface = await showScreen();
        act(() => noteSimulatorActing("agent-1", true));

        expect(screen.getByRole("status")).toHaveTextContent("is using the device");
        fireEvent.pointerDown(surface, pointer(400, 350));
        fireEvent.keyDown(surface, { key: "a" });
        expect(simApi.touch).not.toHaveBeenCalled();
        expect(simApi.text).not.toHaveBeenCalled();

        act(() => noteSimulatorActing("agent-1", false));
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        fireEvent.pointerDown(surface, pointer(400, 350));
        await waitFor(() => expect(simApi.touch).toHaveBeenCalledWith("UDID-1", "down", expect.any(Number), expect.any(Number)));
    });

    it("says when the agent is on another device", async () => {
        await showScreen();
        act(() => noteSimulatorAttached({ agentId: "agent-1", udid: "UDID-2", name: "iPad Air" }));

        expect(screen.getByText(/is on iPad Air/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Show it" })).toBeInTheDocument();

        act(() => noteSimulatorDetached("agent-1"));
        expect(screen.queryByText(/is on iPad Air/)).not.toBeInTheDocument();
    });
});

describe("deviceOptions", () => {
    it("lists running devices first, then iPhones, then iPads, and says who holds one", () => {
        const device = (udid: string, name: string, state: "booted" | "shutdown") => ({ udid, name, state, runtime: "iOS 27.0", model: name });
        const options = deviceOptions(
            [device("pad", "iPad (A16)", "shutdown"), device("air", "iPhone Air", "shutdown"), device("pro", "iPhone 18 Pro", "booted")],
            (udid) => (udid === "air" ? "/code/shop" : undefined),
        );

        expect(options.map((option) => [option.label, option.group])).toEqual([
            ["iPhone 18 Pro", "Running"],
            ["iPhone Air", "iPhone"],
            ["iPad (A16)", "iPad"],
        ]);
        expect(options[1]).toMatchObject({ meta: "iOS 27.0", detail: "In use by shop" });
    });
});
