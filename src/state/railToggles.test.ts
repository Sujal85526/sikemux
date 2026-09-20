import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { focusAgents, toggleSideRail } from "./commands";
import { getState, setState } from "./store";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
});

describe("rail toggles", () => {
    it("toggles the rail when focus mode is off", () => {
        setState({ zenMode: false, sideRailOpen: true });

        toggleSideRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: false });

        toggleSideRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: true });
    });

    it("leaves focus mode and shows the rail", () => {
        setState({ zenMode: true, sideRailOpen: true });

        toggleSideRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: true });
    });

    /* The agents moved into the side rail, so the shortcut that reaches them
       has to open that one — there is no second rail left to reveal. */
    it("reveals the side rail when the agent shortcut fires", () => {
        setState({
            zenMode: false,
            sideRailOpen: false,
            sessions: { p: { id: "p", name: "p", kind: "project", cwd: "/p", deploy: null, pinned: false, activeWindowId: "" } },
            sessionOrder: ["p"],
            activeSessionId: "p",
            windows: {},
            windowsBySession: { p: [] },
        });

        focusAgents();
        expect(getState().sideRailOpen).toBe(true);
    });
});
