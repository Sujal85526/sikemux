import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import * as cmd from "../state/commands";
import { getState, setState } from "../state/store";
import { agentWindowId } from "../state/selectors";
import { withAgents } from "../test/agents";
import { performanceTelemetry } from "../lib/performance";
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
