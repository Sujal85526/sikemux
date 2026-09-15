import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import * as cmd from "../state/commands";
import { getState, setState } from "../state/store";
import { agentWindowId } from "../state/selectors";
import { withAgents } from "../test/agents";
import { performanceTelemetry } from "../lib/performance";
import { GESTURE_END_MS } from "./wheelPan";
import type { Agent } from "../state/types";

vi.mock("../terminal/TerminalPane", () => ({ TerminalPane: () => <div>Terminal output</div> }));
vi.mock("../chat/AgentSurface", () => ({ AgentSurface: () => <div>Agent output</div> }));
vi.mock("./BrowserPane", () => ({ AgentBrowserShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./EditorPane", () => ({ EditorPane: () => <div>Editor document</div> }));

const initial = getState();

beforeEach(() => {
    vi.clearAllMocks();
    setState(initial, true);
    performanceTelemetry.reset();
});
afterEach(cleanup);

const SCREENS = 12;

/** A session whose screens are all mounted at once: a live agent keeps its layer wherever it is. */
function sessionOfScreens(): void {
    const state = getState();
    const sessionId = state.activeSessionId;
    const agents: Agent[] = Array.from({ length: SCREENS }, (_, index) => ({
        id: `agent-${index}`,
        type: "codex",
        title: `agent ${index}`,
        startup: "codex",
        launchState: "live",
    }));
    const slices = withAgents(state, sessionId, agents);
    setState({
        ...slices,
        sessions: {
            ...state.sessions,
            [sessionId]: { ...state.sessions[sessionId], kind: "project", cwd: "/repo", activeWindowId: agentWindowId(slices, "agent-0")! },
        },
    });
}

const slotOf = (layer: Element) => Number((layer as HTMLElement).style.getPropertyValue("--slot"));

describe("workspace pan", () => {
    /*
     * The whole cost claim of the pan is here: a jump across a session paints the
     * screen being left and the screen arriving, and nothing in between, however
     * many screens the session has and however far apart the two are.
     */
    it("paints two layers for a far jump and one once it settles", async () => {
        sessionOfScreens();
        const { container } = render(<Workspace />);
        await act(async () => {});
        expect(container.querySelectorAll(".window-layer").length).toBeGreaterThanOrEqual(SCREENS);

        const sessionId = getState().activeSessionId;
        const to = agentWindowId(getState(), "agent-9")!;
        const homeSlot = getState().windowsBySession[sessionId].indexOf(to);
        act(() => cmd.selectWindowId(to));

        const painted = container.querySelectorAll(".window-layer.painted");
        expect(painted).toHaveLength(2);
        expect(container.querySelector(".window-track")).toHaveClass("panning");

        // Parked beside the screen being left rather than nine screens away, so
        // the track travels one screen either way.
        const slots = Array.from(painted, slotOf).sort((left, right) => left - right);
        expect(slots[1] - slots[0]).toBe(1);
        expect(slots).not.toContain(homeSlot);

        await waitFor(() => expect(container.querySelectorAll(".window-layer.painted")).toHaveLength(1));
        expect(container.querySelector(".window-track")).not.toHaveClass("panning");
        expect(slotOf(container.querySelector(".window-layer.painted")!)).toBe(homeSlot);
    });

    /*
     * Holding the switch shortcut down starts the next slide while the last one is
     * still travelling. The window it leaves behind is the one that slide parked
     * next door, so the next slide has to start from there and not from that
     * window's own screen, or the canvas crosses everything in between.
     */
    it("travels one screen for a switch made while a slide is running", async () => {
        sessionOfScreens();
        const { container } = render(<Workspace />);
        await act(async () => {});

        act(() => cmd.selectWindowId(agentWindowId(getState(), "agent-9")!));
        const parked = slotOf(container.querySelector(".window-layer.live")!);

        act(() => cmd.selectWindowId(agentWindowId(getState(), "agent-11")!));

        const painted = container.querySelectorAll(".window-layer.painted");
        expect(painted).toHaveLength(2);
        const slots = Array.from(painted, slotOf).sort((left, right) => left - right);
        expect(slots[1] - slots[0]).toBe(1);
        expect(slots).toContain(parked);

        const track = container.querySelector(".window-track") as HTMLElement;
        expect(track).toHaveClass("panning");
        expect(track.style.getPropertyValue("--pan")).toBe(`${-(parked + 1) * 100}%`);
    });

    /*
     * Chained slides walk the parked screen along one step at a time, and stepping
     * left far enough takes it past the track's own left edge. The offset has to
     * follow it there or the screen arriving never reaches the stage.
     */
    it("parks a screen left of the track when the chain keeps stepping left", async () => {
        sessionOfScreens();
        const { container } = render(<Workspace />);
        await act(async () => {});
        const track = container.querySelector(".window-track") as HTMLElement;
        const parkedAt = () => slotOf(container.querySelector(".window-layer.live")!);

        for (const agent of ["agent-9", "agent-4", "agent-1", "agent-0"]) {
            act(() => cmd.selectWindowId(agentWindowId(getState(), agent)!));
            expect(track.style.getPropertyValue("--pan")).toBe(`${-parkedAt() * 100}%`);
        }

        expect(parkedAt()).toBe(-1);
    });

    /*
     * The store commits the new window before the slide starts, so the tab pill and
     * the keyboard are already on the target. The layer being left must therefore be
     * out of the a11y tree and unfocusable from the first frame, even while it paints.
     */
    it("hands the target focus and inertness the moment the pan starts", () => {
        sessionOfScreens();
        const { container } = render(<Workspace />);

        act(() => cmd.selectWindowId(agentWindowId(getState(), "agent-1")!));

        const outgoing = container.querySelectorAll(".window-layer.painted:not(.live)");
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]).toHaveAttribute("inert");
        expect(outgoing[0]).toHaveAttribute("aria-hidden", "true");
        const incoming = container.querySelectorAll(".window-layer.live");
        expect(incoming).toHaveLength(1);
        expect(incoming[0]).not.toHaveAttribute("inert");
    });

    it("records a tab-pan span", async () => {
        sessionOfScreens();
        render(<Workspace />);
        act(() => cmd.selectWindowId(agentWindowId(getState(), "agent-3")!));

        await waitFor(() => expect(performanceTelemetry.snapshot().spans.map((span) => span.name)).toContain("tab-pan"));
        const span = performanceTelemetry.snapshot().spans.find((entry) => entry.name === "tab-pan")!;
        expect(span.metadata).toMatchObject({ distance: 3, teleported: true });
    });

    /*
     * Two documents of one editor are one screen, not two, so the canvas has
     * nowhere to slide to.
     */
    it("does not pan when the document changes inside one window", () => {
        cmd.requestOpenFile("/repo/a.ts");
        cmd.requestOpenFile("/repo/b.ts");
        const { container } = render(<Workspace />);
        const editorWindow = getState().sessions[getState().activeSessionId].activeWindowId;

        act(() => cmd.selectTab({ id: editorWindow, doc: "/repo/a.ts" }));

        expect(container.querySelector(".window-track")).not.toHaveClass("panning");
        expect(container.querySelectorAll(".window-layer.painted")).toHaveLength(1);
    });

    it("cuts straight through when motion is reduced", () => {
        vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
        sessionOfScreens();
        const { container } = render(<Workspace />);

        act(() => cmd.selectWindowId(agentWindowId(getState(), "agent-5")!));

        expect(container.querySelector(".window-track")).not.toHaveClass("panning");
        expect(container.querySelectorAll(".window-layer.painted")).toHaveLength(1);
        vi.unstubAllGlobals();
    });
});

describe("workspace wheel pan", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const STAGE_WIDTH = 1000;
    const activeWindow = () => getState().sessions[getState().activeSessionId].activeWindowId;
    const order = () => getState().windowsBySession[getState().activeSessionId];

    /** jsdom lays nothing out, so the stage has to be told how wide a screen is. */
    function stageOfScreens(): { track: HTMLElement; live: HTMLElement; index: number; container: HTMLElement } {
        sessionOfScreens();
        const { container } = render(<Workspace />);
        Object.defineProperty(container.querySelector(".window-area")!, "clientWidth", { value: STAGE_WIDTH, configurable: true });
        return {
            container,
            track: container.querySelector(".window-track") as HTMLElement,
            live: container.querySelector(".window-layer.live") as HTMLElement,
            index: order().indexOf(activeWindow()),
        };
    }

    const swipe = (over: Element, deltaX: number, deltaY = 0) => fireEvent.wheel(over, { deltaX, deltaY });

    /*
     * The finger drives the track directly: the offsets are on, the screen it is
     * heading for paints beside the one on stage, and nothing transitions while
     * the gesture is still going.
     */
    it("commits the screen next door when a swipe crosses half of it", () => {
        const { container, track, live, index } = stageOfScreens();
        const neighbour = order()[index + 1];

        expect(swipe(live, 300)).toBe(false);
        swipe(live, 300);

        expect(track).toHaveClass("panning");
        expect(track).not.toHaveClass("sliding");
        expect(container.querySelectorAll(".window-layer.painted")).toHaveLength(2);
        act(() => void vi.advanceTimersByTime(20));
        expect(track.style.getPropertyValue("--pan")).toBe(`${-(index + 0.6) * 100}%`);

        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(activeWindow()).toBe(neighbour);
        expect(track).toHaveClass("sliding");
        expect(track.style.getPropertyValue("--pan")).toBe(`${-(index + 1) * 100}%`);
    });

    /*
     * The settle transition has to run from where the finger left the track, and
     * for a swipe that is put back React has no reason to write `--pan` at all —
     * the track is heading for the screen it was already on.
     */
    it("puts the screen back when the swipe never gets halfway", () => {
        const { track, live, index } = stageOfScreens();
        const before = activeWindow();

        swipe(live, 200);
        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(activeWindow()).toBe(before);
        expect(track).toHaveClass("sliding");
        expect(track.style.getPropertyValue("--pan")).toBe(`${-index * 100}%`);
    });

    /*
     * Whether the stage takes a gesture is decided on its first event and kept
     * for the rest of it, so scrolling a wide pane to its edge does not throw the
     * tail of the same swipe at the stage.
     */
    it("leaves a swipe to the pane under it, even after that pane runs out of room", () => {
        const { track, live } = stageOfScreens();
        const before = activeWindow();
        const pane = live.appendChild(document.createElement("div"));
        pane.style.overflowX = "auto";
        Object.defineProperty(pane, "scrollWidth", { value: 800, configurable: true });
        Object.defineProperty(pane, "clientWidth", { value: 300, configurable: true });
        Object.defineProperty(pane, "scrollLeft", { value: 0, writable: true, configurable: true });

        expect(swipe(pane, 300)).toBe(true);
        pane.scrollLeft = 500;
        expect(swipe(pane, 300)).toBe(true);
        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(track).not.toHaveClass("panning");
        expect(activeWindow()).toBe(before);
    });

    it("leaves a gesture that is mostly vertical to whatever is under it", () => {
        const { track, live } = stageOfScreens();

        expect(swipe(live, 60, 50)).toBe(true);
        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(track).not.toHaveClass("panning");
    });

    it("keeps the strip's own scrolling to itself", () => {
        const { container, track } = stageOfScreens();
        const strip = container.querySelector(".tabbar")!;

        expect(swipe(strip, 300)).toBe(true);
        expect(track).not.toHaveClass("panning");
    });

    /*
     * A switch made while the fingers are still moving takes the session off the
     * screen the swipe was dragging, so the swipe has nothing left to land on. Its
     * snap would otherwise override the screen already chosen.
     */
    it("lands nothing when the session has already left the screen it swiped", () => {
        const { live, index } = stageOfScreens();
        const chosen = order()[index + 4];

        swipe(live, 300);
        swipe(live, 300);
        act(() => cmd.selectWindowId(chosen));
        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(activeWindow()).toBe(chosen);
    });

    /*
     * Dragging is direct manipulation rather than animation, so it still follows
     * the finger with motion reduced; only the settle stops being a slide.
     */
    it("cuts to the screen it lands on when motion is reduced", () => {
        vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
        const { track, live, index } = stageOfScreens();
        const neighbour = order()[index + 1];

        swipe(live, 300);
        swipe(live, 300);
        expect(track).toHaveClass("panning");

        act(() => void vi.advanceTimersByTime(GESTURE_END_MS));

        expect(activeWindow()).toBe(neighbour);
        expect(track).not.toHaveClass("panning");
        vi.unstubAllGlobals();
    });
});

describe("window scroll indicator", () => {
    const sessionId = () => getState().activeSessionId;
    const order = () => getState().windowsBySession[sessionId()];

    /*
     * The thumb says where the window really is in the session. A far jump parks
     * the canvas next door and slides one screen, and the thumb has to cross the
     * whole gap regardless, or it would report the parked screen as the place.
     */
    it("sizes the thumb by screen count and places it by the real index", () => {
        sessionOfScreens();
        const { container } = render(<Workspace />);
        const thumb = () => container.querySelector(".window-scroll-thumb") as HTMLElement;
        const count = order().length;

        expect(thumb().style.width).toBe(`${100 / count}%`);
        expect(thumb().style.transform).toBe(`translateX(${order().indexOf(getState().sessions[sessionId()].activeWindowId) * 100}%)`);

        const to = agentWindowId(getState(), "agent-9")!;
        const index = order().indexOf(to);
        act(() => cmd.selectWindowId(to));

        expect(thumb().style.transform).toBe(`translateX(${index * 100}%)`);
        expect(slotOf(container.querySelector(".window-layer.live")!)).not.toBe(index);
    });

    it("has nothing to show for a session of one screen", () => {
        const { container } = render(<Workspace />);

        expect(order()).toHaveLength(1);
        expect(container.querySelector(".window-scroll")).toBeNull();
    });
});
