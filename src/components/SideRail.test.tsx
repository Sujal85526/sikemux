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
        activeAgentId: null,
        view: "windows",
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
        agentsBySession: Object.fromEntries(Object.keys(sessions).map((id) => [id, []])),
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("project sorting", () => {
    it("drags a project before another project and shows the insertion point", () => {
        render(<SideRail />);
        const source = screen.getByRole("button", { name: "gamma" });
        const target = screen.getByRole("button", { name: "alpha" });
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
        vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ left: 8, top: 80, width: 210, height: 26 } as DOMRect);
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 48, height: 28 } as DOMRect);

        fireEvent.pointerDown(source, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(window, { clientX: 0, clientY: 22 });

        const ghost = document.querySelector<HTMLElement>("[data-project-drag-ghost]");
        expect(ghost).toHaveStyle({ width: "210px", height: "26px" });
        expect(ghost?.querySelector(".project-drag-ghost-row")).toHaveTextContent("gamma");
        expect(ghost?.querySelector(".project-drag-ghost-card")).not.toBeInTheDocument();
        expect(getState().sessionOrder).toEqual(["gamma", "ssh", "alpha", "command", "beta"]);
        expect(screen.getByRole("button", { name: "alpha" }).closest("[data-project-id]")).toHaveClass("project-drop-before");

        fireEvent.pointerUp(window, { clientX: 0, clientY: 22 });

        expect(getState().sessionOrder).toEqual(["gamma", "ssh", "alpha", "command", "beta"]);
    });
});
