import { describe, expect, it } from "vitest";
import { activeTabRef, expandTabRefs, nextInCycle, roleHasTab, stripOrder, tabRefKey, tabRefWindowId } from "./selectors";
import type { StoreState } from "./store";

const win = (id: string, role: string) => ({ id, role, activePaneId: `${id}-pane` }) as unknown as StoreState["windows"][string];
const brunoViews = (paneId: string, openPaths: string[], activeRequestPath: string | null = null) =>
    ({ [paneId]: { openPaths, activeRequestPath } }) as StoreState["brunoViews"];

describe("roleHasTab", () => {
    /*
     * The rail reaches these and the stage renders them, so a tab would be a
     * second handle on one surface — "Changes" in the rail and "Diff" in the
     * strip meant the same diff.
     */
    it("denies a window tab to the roles the workspace rail drives", () => {
        expect(roleHasTab("diff")).toBe(false);
        expect(roleHasTab("search")).toBe(false);
    });

    /*
     * An editor is not one surface. The rail browses the tree, but each open
     * document is its own thing to switch between, so an editor contributes a
     * tab per document rather than none — see the expandTabRefs cases below.
     */
    it("leaves the editor out of the window rule, since it expands per document", () => {
        expect(roleHasTab("files")).toBe(true);
    });

    it("keeps a tab for every role nothing else can reach", () => {
        for (const role of ["term", "git", "aws", "rundeck", "bruno", "ssh-config", "named"]) {
            expect(roleHasTab(role)).toBe(true);
        }
    });
});

describe("expandTabRefs", () => {
    it("leaves out rail-driven windows and keeps the rest", () => {
        const refs = expandTabRefs(["t1", "e1", "d1", "s1", "g1"], {
            t1: win("t1", "term"),
            e1: win("e1", "files"),
            d1: win("d1", "diff"),
            s1: win("s1", "search"),
            g1: win("g1", "git"),
        });

        expect(refs.map(tabRefKey)).toEqual(["window:t1", "window:g1"]);
    });

    it("expands an editor into one tab per open document, in their open order", () => {
        const refs = expandTabRefs(["e1"], { e1: win("e1", "files") }, { "e1-pane": { openTabs: ["/a.ts", "/b.ts"], activePath: "/b.ts" } });

        expect(refs.map(tabRefKey)).toEqual(["file:e1:/a.ts", "file:e1:/b.ts"]);
    });

    it("gives an editor holding nothing no tab at all", () => {
        const refs = expandTabRefs(["e1"], { e1: win("e1", "files") }, { "e1-pane": { openTabs: [], activePath: null } });

        expect(refs).toEqual([]);
    });

    it("keeps a document's tab beside the terminals and agents it shares a strip with", () => {
        const refs = expandTabRefs(
            ["t1", "e1", "a1"],
            { t1: win("t1", "term"), e1: win("e1", "files"), a1: win("a1", "agent") },
            { "e1-pane": { openTabs: ["/a.ts"], activePath: "/a.ts" } },
        );

        expect(refs.map(tabRefKey)).toEqual(["window:t1", "file:e1:/a.ts", "window:a1"]);
    });

    it("expands a Bruno workspace into one tab per open request, in their open order", () => {
        const refs = expandTabRefs(["b1"], { b1: win("b1", "bruno") }, {}, brunoViews("b1-pane", ["/a.bru", "/b.bru"]));

        expect(refs.map(tabRefKey)).toEqual(["request:b1:/a.bru", "request:b1:/b.bru"]);
    });

    /*
     * The Bruno pane's own tree is how you open the first request, so an empty
     * workspace needs no tab — the same rule the editor follows.
     */
    it("gives a Bruno workspace holding nothing no tab at all", () => {
        expect(expandTabRefs(["b1"], { b1: win("b1", "bruno") }, {}, brunoViews("b1-pane", []))).toEqual([]);
        expect(expandTabRefs(["b1"], { b1: win("b1", "bruno") })).toEqual([]);
    });

    it("drops ids with no record", () => {
        const refs = expandTabRefs(["t1", "gone"], { t1: win("t1", "term") });

        expect(refs.map(tabRefKey)).toEqual(["window:t1"]);
    });

    it("yields no tabs for a project holding only rail-driven surfaces", () => {
        const refs = expandTabRefs(["e1", "d1"], { e1: win("e1", "files"), d1: win("d1", "diff") });

        expect(refs).toEqual([]);
    });
});

describe("activeTabRef", () => {
    const session = (over: Record<string, unknown> = {}) => ({ activeWindowId: "e1", ...over }) as unknown as Parameters<typeof activeTabRef>[0];

    it("resolves an active editor to the document it is showing", () => {
        const ref = activeTabRef(session(), { e1: win("e1", "files") }, { "e1-pane": { openTabs: ["/a.ts", "/b.ts"], activePath: "/b.ts" } });

        expect(ref && tabRefKey(ref)).toBe("file:e1:/b.ts");
    });

    /*
     * An editor showing nothing has no document tab to point at, but its layer
     * still has to render the empty state, so it stays a window ref.
     */
    it("keeps an empty editor a window ref so its layer still renders", () => {
        const ref = activeTabRef(session(), { e1: win("e1", "files") }, { "e1-pane": { openTabs: [], activePath: null } });

        expect(ref && tabRefKey(ref)).toBe("window:e1");
    });

    it("resolves an active Bruno workspace to the request it is showing", () => {
        const ref = activeTabRef(
            session({ kind: "bruno", activeWindowId: "b1" }),
            { b1: win("b1", "bruno") },
            {},
            brunoViews("b1-pane", ["/a.bru"], "/a.bru"),
        );

        expect(ref && tabRefKey(ref)).toBe("request:b1:/a.bru");
    });

    it("keeps an empty Bruno workspace a window ref so its layer still renders", () => {
        const ref = activeTabRef(session({ kind: "bruno", activeWindowId: "b1" }), { b1: win("b1", "bruno") }, {}, brunoViews("b1-pane", []));

        expect(ref && tabRefKey(ref)).toBe("window:b1");
    });

    it("still names the window itself for every other role", () => {
        const ref = activeTabRef(session({ activeWindowId: "t1" }), { t1: win("t1", "term") }, {});

        expect(ref && tabRefKey(ref)).toBe("window:t1");
    });
});

describe("tabRefWindowId", () => {
    /*
     * Layer visibility asks this rather than matching on kind. Matching on
     * `kind === "window"` meant a document tab lit no layer at all, leaving the
     * stage blank while the strip showed the file as active.
     */
    it("points a document tab at the editor holding it", () => {
        expect(tabRefWindowId({ kind: "file", id: "e1", path: "/a.ts" })).toBe("e1");
    });

    it("points a request tab at the Bruno workspace holding it", () => {
        expect(tabRefWindowId({ kind: "request", id: "b1", path: "/a.bru" })).toBe("b1");
    });

    it("points a window tab at itself", () => {
        expect(tabRefWindowId({ kind: "window", id: "t1" })).toBe("t1");
        expect(tabRefWindowId(null)).toBeNull();
    });
});

const storeState = (over: Partial<StoreState>): StoreState =>
    ({
        sessions: {},
        windows: {},
        agents: {},
        editorViews: {},
        brunoViews: {},
        windowsBySession: {},
        ...over,
    }) as unknown as StoreState;

describe("nextInCycle", () => {
    it("has nowhere to go in an empty list", () => {
        expect(nextInCycle({ ids: [], activeId: null }, 1)).toBeNull();
    });

    it("wraps at both ends", () => {
        const order = { ids: ["a", "b", "c"], activeId: "c" };
        expect(nextInCycle(order, 1)).toBe("a");
        expect(nextInCycle({ ...order, activeId: "a" }, -1)).toBe("c");
    });

    /*
     * A strip whose active id is gone still has to move somewhere, so the walk
     * starts from the first entry rather than refusing.
     */
    it("starts from the first entry when the active id is not in the list", () => {
        expect(nextInCycle({ ids: ["a", "b"], activeId: "gone" }, 1)).toBe("b");
        expect(nextInCycle({ ids: ["a", "b"], activeId: null }, 1)).toBe("b");
    });

    it("returns the only entry rather than nothing", () => {
        expect(nextInCycle({ ids: ["a"], activeId: "a" }, 1)).toBe("a");
    });
});

describe("stripOrder", () => {
    it("reads the workspace strip as keys with the active one named", () => {
        const state = storeState({
            sessions: { s1: { id: "s1", kind: "project", activeWindowId: "t2" } },
            windows: { t1: win("t1", "term"), t2: win("t2", "term"), a1: win("a1", "agent") },
            windowsBySession: { s1: ["t1", "t2", "a1"] },
        } as unknown as Partial<StoreState>);

        expect(stripOrder(state, { kind: "workspace", sessionId: "s1" })).toEqual({
            ids: ["window:t1", "window:t2", "window:a1"],
            activeId: "window:t2",
        });
    });

    /* ⌥. inside an agent walks the agent windows only, by window id, since that is what gets selected. */
    it("reads a session's agent windows", () => {
        const state = storeState({
            sessions: { s1: { id: "s1", activeWindowId: "w2" } },
            windows: { w1: win("w1", "agent"), t1: win("t1", "term"), w2: win("w2", "agent") },
            windowsBySession: { s1: ["w1", "t1", "w2"] },
        } as unknown as Partial<StoreState>);

        expect(stripOrder(state, { kind: "agents", sessionId: "s1" })).toEqual({ ids: ["w1", "w2"], activeId: "w2" });
    });

    /*
     * ⌥. inside a terminal walks terminals only, so a git or editor window
     * sharing the session must not land in the list.
     */
    it("reads only the terminal windows, and drops an active window that is not one", () => {
        const state = storeState({
            sessions: { s1: { id: "s1", activeWindowId: "g1" } },
            windows: { t1: win("t1", "term"), g1: win("g1", "git"), t2: win("t2", "term") },
            windowsBySession: { s1: ["t1", "g1", "t2"] },
        } as unknown as Partial<StoreState>);

        expect(stripOrder(state, { kind: "terminals", sessionId: "s1" })).toEqual({ ids: ["t1", "t2"], activeId: null });
    });

    it("reads an editor pane's documents and a Bruno session's requests", () => {
        const state = storeState({
            editorViews: { p1: { openTabs: ["/a.ts", "/b.ts"], activePath: "/b.ts" } },
            brunoViews: { p2: { openPaths: ["/a.bru"], activeRequestPath: "/a.bru" } },
        } as unknown as Partial<StoreState>);

        expect(stripOrder(state, { kind: "documents", paneId: "p1" })).toEqual({ ids: ["/a.ts", "/b.ts"], activeId: "/b.ts" });
        expect(stripOrder(state, { kind: "requests", paneId: "p2" })).toEqual({ ids: ["/a.bru"], activeId: "/a.bru" });
    });

    it("reads an absent list as empty rather than throwing", () => {
        const state = storeState({});
        expect(stripOrder(state, { kind: "documents", paneId: "missing" })).toEqual({ ids: [], activeId: null });
        expect(stripOrder(state, { kind: "agents", sessionId: "missing" })).toEqual({ ids: [], activeId: null });
    });
});
