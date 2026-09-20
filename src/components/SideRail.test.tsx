import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../state/store";
import type { Session, SessionKind } from "../state/types";
import { SideRail } from "./SideRail";

const initial = getState();

function session(id: string, kind: SessionKind): Session {
    return {
        id,
        name: id,
        kind,
        cwd: `/${id}`,
        deploy: null,
        pinned: false,
        activeWindowId: "",
    };
}

beforeEach(() => {
    setState(initial, true);
    const sessions = {
        alpha: session("alpha", "project"),
        ssh: session("ssh", "ssh"),
        beta: session("beta", "project"),
        command: session("command", "command"),
        gamma: session("gamma", "project"),
    };
    setState({
        sessions,
        sessionOrder: ["alpha", "ssh", "beta", "command", "gamma"],
        activeSessionId: "command",
        windows: {},
        windowsBySession: Object.fromEntries(Object.keys(sessions).map((id) => [id, []])),
        agents: {},
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("project sorting", () => {
    /*
     * The strip is horizontal, so a reorder is a horizontal pointer drag —
     * and the page swipe is a wheel gesture, so the two never contend for the
     * same movement. Same split a browser's tab strip makes.
     */
    it("drags a project chip before another and reorders on release", () => {
        render(<SideRail />);
        const source = screen.getByRole("button", { name: "gamma" });
        const target = screen.getByRole("button", { name: "alpha" });
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, width: 80 } as DOMRect);

        fireEvent.pointerDown(source, { button: 0, clientX: 300, clientY: 20 });
        // Under the threshold is still a click, not a drag.
        fireEvent.pointerMove(window, { clientX: 298, clientY: 20 });
        expect(source).not.toHaveClass("dragging");

        fireEvent.pointerMove(window, { clientX: 120, clientY: 20 });
        expect(source).toHaveClass("dragging");
        expect(target).toHaveClass("drop-before");
        expect(getState().sessionOrder).toEqual(["alpha", "ssh", "beta", "command", "gamma"]);

        /* Reordering is by kind: the projects become gamma, alpha, beta and
           refill the slots the projects already held, so the ssh host and the
           command session do not shuffle around them. */
        fireEvent.pointerUp(window, { clientX: 120, clientY: 20 });
        expect(getState().sessionOrder).toEqual(["gamma", "ssh", "alpha", "command", "beta"]);
    });

    it("drops after a chip when the pointer is past its middle", () => {
        render(<SideRail />);
        const source = screen.getByRole("button", { name: "alpha" });
        const target = screen.getByRole("button", { name: "gamma" });
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, width: 80 } as DOMRect);

        fireEvent.pointerDown(source, { button: 0, clientX: 20, clientY: 20 });
        fireEvent.pointerMove(window, { clientX: 170, clientY: 20 });
        expect(target).toHaveClass("drop-after");

        fireEvent.pointerUp(window, { clientX: 170, clientY: 20 });
        expect(getState().sessionOrder).toEqual(["beta", "ssh", "gamma", "command", "alpha"]);
    });
});

describe("project tree", () => {
    it("ends the spine on the last child row", () => {
        setState({ activeSessionId: "alpha" });
        render(<SideRail />);
        const children = document.querySelector(".proj-children");
        const rows = children?.querySelectorAll(".proj-child") ?? [];

        expect(rows.length).toBeGreaterThan(1);
        expect(children?.lastElementChild).toHaveClass("proj-child");
        for (const row of rows) {
            expect(row.parentElement).toBe(children);
        }
    });
});
