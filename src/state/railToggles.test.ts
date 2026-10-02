import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { toggleAgentRail, toggleSideRail, toggleZen } from "./commands";
import { selectFocusMode } from "./selectors";
import { getState, setState } from "./store";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
});

describe("rail toggles", () => {
    it("toggles each rail on its own", () => {
        setState({ sideRailOpen: true, agentRailOpen: true });

        toggleSideRail();
        expect(getState()).toMatchObject({ sideRailOpen: false, agentRailOpen: true });

        toggleSideRail();
        expect(getState()).toMatchObject({ sideRailOpen: true, agentRailOpen: true });
    });

    it("is in focus mode exactly when both rails are hidden", () => {
        setState({ sideRailOpen: true, agentRailOpen: true });

        toggleSideRail();
        expect(selectFocusMode(getState())).toBe(false);

        toggleAgentRail();
        expect(selectFocusMode(getState())).toBe(true);

        toggleAgentRail();
        expect(selectFocusMode(getState())).toBe(false);
    });

    it("entering focus mode hides both rails and leaving it shows both", () => {
        setState({ sideRailOpen: true, agentRailOpen: false });

        toggleZen();
        expect(getState()).toMatchObject({ sideRailOpen: false, agentRailOpen: false });
        expect(selectFocusMode(getState())).toBe(true);

        toggleZen();
        expect(getState()).toMatchObject({ sideRailOpen: true, agentRailOpen: true });
        expect(selectFocusMode(getState())).toBe(false);
    });
});
