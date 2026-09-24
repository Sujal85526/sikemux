import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../state/store";
import type { Session, SessionKind } from "../state/types";
import "../plugins/builtin";
import { SideRail } from "./SideRail";

const initial = getState();

function session(id: string, kind: SessionKind): Session {
    return {
        id,
        name: id,
        kind,
        cwd: `/${id}`,
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
    it("drags a project before another project and shows the insertion point", () => {
        render(<SideRail />);
        const source = screen.getByRole("button", { name: "gamma" });
        const target = screen.getByRole("button", { name: "alpha" });
        let ghostWasHiddenDuringHitTest = false;
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: vi.fn(() => {
                ghostWasHiddenDuringHitTest ||= document.querySelector<HTMLElement>("[data-project-drag-ghost]")?.style.visibility === "hidden";
                return target;
            }),
        });
        vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ left: 8, top: 80, width: 210, height: 26 } as DOMRect);
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 48, height: 28 } as DOMRect);

        fireEvent.pointerDown(source, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(window, { clientX: 0, clientY: 22 });
        fireEvent.pointerMove(window, { clientX: 0, clientY: 23 });

        const ghost = document.querySelector<HTMLElement>("[data-project-drag-ghost]");
        expect(ghost).toHaveStyle({ width: "210px", height: "26px" });
        expect(ghost?.querySelector(".project-drag-ghost-row")).toHaveTextContent("gamma");
        expect(ghost?.querySelector(".project-drag-ghost-card")).not.toBeInTheDocument();
        /*
         * The ghost is styled by class — `.project-drag-ghost *` takes the
         * pointer events away. It used to arrive with every computed style of
         * every element written back as an inline property, which is hundreds
         * of reads at the moment a drag starts.
         */
        for (const element of ghost?.querySelectorAll<HTMLElement>("*") ?? []) {
            expect(element.getAttribute("style")).toBeNull();
        }
        expect(ghostWasHiddenDuringHitTest).toBe(true);
        expect(ghost?.style.visibility).toBe("");
        expect(getState().sessionOrder).toEqual(["gamma", "ssh", "alpha", "command", "beta"]);
        expect(screen.getByRole("button", { name: "alpha" }).closest("[data-project-id]")).toHaveClass("project-drop-before");

        fireEvent.pointerUp(window, { clientX: 0, clientY: 22 });

        expect(getState().sessionOrder).toEqual(["gamma", "ssh", "alpha", "command", "beta"]);
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

describe("plugins group", () => {
    it("gathers AWS, Bruno and every plugin under one group, offering whatever is not open", () => {
        setState({
            sessions: { ...getState().sessions, aws: session("aws", "aws"), signoz: session("signoz", "sikemux.signoz:explore") },
            sessionOrder: [...getState().sessionOrder, "aws", "signoz"],
            windowsBySession: { ...getState().windowsBySession, aws: [], signoz: [] },
            pluginManifests: [
                { id: "sikemux.rundeck", name: "Rundeck", version: "0.1.0", sikemux: ">=0.4" },
                { id: "sikemux.signoz", name: "SigNoz", version: "0.1.0", sikemux: ">=0.4" },
            ],
        });
        render(<SideRail />);

        expect(screen.getByText("Plugins")).toBeTruthy();
        for (const gone of ["Cloud", "CI/CD", "Observability"]) expect(screen.queryByText(gone)).toBeNull();
        expect(screen.getByRole("button", { name: "aws" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "signoz" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "open rundeck deploy center" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "open bruno" })).toBeTruthy();
        expect(screen.queryByText("API")).toBeNull();
        expect(screen.queryByRole("button", { name: "open aws" })).toBeNull();
        expect(screen.queryByRole("button", { name: "open signoz" })).toBeNull();
    });
});
