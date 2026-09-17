import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { toggleAgentRail, toggleSideRail } from "./commands";
import { getState, setState } from "./store";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
});

describe("rail toggles", () => {
    it("toggles a rail on its own when focus mode is off", () => {
        setState({ zenMode: false, sideRailOpen: true, agentRailOpen: false });

        toggleSideRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: false, agentRailOpen: false });

        toggleAgentRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: false, agentRailOpen: true });
    });

    it("leaves focus mode and shows the rail that was asked for", () => {
        setState({ zenMode: true, sideRailOpen: true, agentRailOpen: false });

        toggleSideRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: true, agentRailOpen: false });

        setState({ zenMode: true, sideRailOpen: false, agentRailOpen: false });
        toggleAgentRail();
        expect(getState()).toMatchObject({ zenMode: false, sideRailOpen: false, agentRailOpen: true });
    });
});
