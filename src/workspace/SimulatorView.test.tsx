import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { simulatorApi, type SimulatorFrame } from "../api/simulator";
import { SimulatorView, toDevicePoint, typedText } from "./SimulatorView";

vi.mock("../api/simulator", async () => {
    const actual = await vi.importActual<typeof import("../api/simulator")>("../api/simulator");
    return {
        ...actual,
        simulatorApi: { openView: vi.fn(), closeView: vi.fn(), input: vi.fn(), subscribeFrames: vi.fn(), subscribeAttached: vi.fn() },
    };
});

afterEach(() => vi.clearAllMocks());

const iPhone = { width: 402, height: 874 };

describe("mapping a click to the simulator's screen", () => {
    it("scales a point on a screen drawn at half size to device points", () => {
        const drawn = { left: 100, top: 50, width: 201, height: 437 };
        expect(toDevicePoint(drawn, iPhone, 100 + 170, 50 + 217)).toEqual({ x: 340, y: 434 });
    });

    it("leaves out the margins when the box is wider than the screen", () => {
        const wide = { left: 0, top: 0, width: 1000, height: 874 };
        expect(toDevicePoint(wide, iPhone, 299, 400)).toEqual({ x: 0, y: 400 });
        expect(toDevicePoint(wide, iPhone, 200, 400)).toBeNull();
        expect(toDevicePoint(wide, iPhone, 800, 400)).toBeNull();
    });

    it("misses when there is nothing to draw on", () => {
        expect(toDevicePoint({ left: 0, top: 0, width: 0, height: 0 }, iPhone, 0, 0)).toBeNull();
    });
});

describe("keys typed into the simulator", () => {
    const key = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) =>
        typedText({ key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });

    it("types characters, Return, Tab and Backspace", () => {
        expect(key("a")).toBe("a");
        expect(key("A")).toBe("A");
        expect(key("Enter")).toBe("\n");
        expect(key("Tab")).toBe("\t");
        expect(key("Backspace")).toBe("\b");
    });

    it("leaves shortcuts and named keys to Sikemux", () => {
        expect(key("w", { metaKey: true })).toBeNull();
        expect(key("c", { ctrlKey: true })).toBeNull();
        expect(key("ArrowLeft")).toBeNull();
        expect(key("Shift")).toBeNull();
    });
});

describe("the simulator view", () => {
    const device = { udid: "U1", name: "iPhone 18 Pro", os: "iOS 27.0", screen: iPhone };

    function mount(live: boolean) {
        let deliver: (frame: SimulatorFrame) => void = () => {};
        vi.mocked(simulatorApi.subscribeFrames).mockImplementation(async (listener) => {
            deliver = listener;
            return () => {};
        });
        vi.mocked(simulatorApi.openView).mockResolvedValue();
        vi.mocked(simulatorApi.closeView).mockResolvedValue();
        vi.mocked(simulatorApi.input).mockResolvedValue();
        const view = render(<SimulatorView simulator={device} live={live} />);
        return { view, screen: within(view.container), deliver: (frame: SimulatorFrame) => act(() => deliver(frame)) };
    }

    it("watches the screen only while it is live, and shows each frame as it arrives", async () => {
        const { view, screen, deliver } = mount(true);
        await vi.waitFor(() => expect(simulatorApi.openView).toHaveBeenCalledWith("U1"));
        expect(screen.getByText("Connecting to iPhone 18 Pro…")).toBeTruthy();

        deliver({ udid: "other", frame: 1 });
        expect(screen.queryByRole("img")).toBeNull();
        deliver({ udid: "U1", frame: 3 });
        expect(screen.getByRole("img").getAttribute("src")).toBe("sim://localhost/U1/3");

        view.rerender(<SimulatorView simulator={device} live={false} />);
        expect(simulatorApi.closeView).toHaveBeenCalledWith("U1");
    });

    it("says why the stream stopped", async () => {
        const { screen, deliver } = mount(true);
        await vi.waitFor(() => expect(simulatorApi.subscribeFrames).toHaveBeenCalled());
        deliver({ udid: "U1", error: "the simulator stream answered HTTP/1.1 404" });
        expect(screen.getByText(/The simulator view stopped: the simulator stream answered/)).toBeTruthy();
    });

    it("turns a click on the screen into a tap there, and the Home button into a press", async () => {
        const { screen, deliver } = mount(true);
        await vi.waitFor(() => expect(simulatorApi.subscribeFrames).toHaveBeenCalled());
        deliver({ udid: "U1", frame: 1 });
        const image = screen.getByRole("img");
        image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 201, height: 437 }) as DOMRect;
        const stage = screen.getByRole("application");
        stage.setPointerCapture = () => {};

        fireEvent.pointerDown(stage, { clientX: 170, clientY: 217, button: 0, pointerId: 1 });
        fireEvent.pointerUp(stage, { clientX: 170, clientY: 217, pointerId: 1 });
        expect(simulatorApi.input).toHaveBeenCalledWith("U1", { type: "tap", x: 340, y: 434 });

        fireEvent.click(screen.getByRole("button", { name: "Home" }));
        expect(simulatorApi.input).toHaveBeenCalledWith("U1", { type: "button", button: "home" });
    });

    it("does not watch a simulator that is not on screen", () => {
        mount(false);
        expect(simulatorApi.openView).not.toHaveBeenCalled();
    });
});
