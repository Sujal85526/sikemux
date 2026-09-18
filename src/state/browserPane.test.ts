import { beforeEach, describe, expect, it } from "vitest";
import { closeBrowserPane, openBrowserPane } from "./commands";
import { collectPanes } from "./layout";
import { getState, setState } from "./store";

const initial = getState();

/* An agent pane in a window, which is what a browser gets opened beside. */
function window_() {
    return {
        id: "window",
        name: "1",
        role: "agent" as const,
        root: { type: "pane" as const, id: "agent-1", cwd: "/code", kind: "agent" as const, title: "codex" },
        activePaneId: "agent-1",
    };
}

beforeEach(() => {
    setState(initial, true);
    setState({
        sessions: {
            project: {
                id: "project",
                name: "project",
                kind: "project" as const,
                cwd: "/code",
                deploy: null,
                pinned: false,
                activeWindowId: "window",
            },
        },
        sessionOrder: ["project"],
        activeSessionId: "project",
        windows: { window: window_() },
        windowsBySession: { project: ["window"] },
        browserPanes: {},
    } as never);
});

describe("the browser pane", () => {
    it("opens beside the agent it belongs to, as a leaf in the same window", () => {
        openBrowserPane("agent-1");

        const root = getState().windows.window.root;
        expect(root.type).toBe("split");
        const panes = collectPanes(root);
        expect(panes.map((pane) => pane.kind)).toEqual(["agent", "browser"]);
        const browser = panes[1];
        expect(getState().browserPanes[browser.id]).toBe("agent-1");
        expect(getState().windows.window.activePaneId).toBe(browser.id);
    });

    it("opens once, and focuses the pane it already made", () => {
        openBrowserPane("agent-1");
        const first = collectPanes(getState().windows.window.root)[1].id;
        setState({ windows: { window: { ...getState().windows.window, activePaneId: "agent-1" } } } as never);

        openBrowserPane("agent-1");

        expect(collectPanes(getState().windows.window.root)).toHaveLength(2);
        expect(getState().windows.window.activePaneId).toBe(first);
    });

    it("takes the pane back out when its last tab goes", () => {
        openBrowserPane("agent-1");
        const browserId = collectPanes(getState().windows.window.root)[1].id;

        closeBrowserPane(browserId);

        expect(collectPanes(getState().windows.window.root).map((pane) => pane.kind)).toEqual(["agent"]);
        expect(getState().browserPanes[browserId]).toBeUndefined();
        expect(getState().windows.window.activePaneId).toBe("agent-1");
    });

    it("does nothing for an agent that is not in any window", () => {
        openBrowserPane("ghost");

        expect(collectPanes(getState().windows.window.root)).toHaveLength(1);
        expect(getState().browserPanes).toEqual({});
    });
});
