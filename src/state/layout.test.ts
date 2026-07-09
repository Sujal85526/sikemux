import { describe, expect, it } from "vitest";
import { MIN_FRAC, collectPanes, computeLayout, makePane, neighborPane, removePane, resizeTowards, setSplitSizes, splitPane } from "./layout";
import type { LayoutNode, PaneNode } from "./types";

const pane = (id: string): PaneNode => ({ type: "pane", id, cwd: `/tmp/${id}`, kind: "terminal", title: id });

describe("layout helpers", () => {
    it("creates panes with stable defaults", () => {
        const p = makePane("/repo");
        expect(p.type).toBe("pane");
        expect(p.id).toMatch(/^pane-/);
        expect(p.cwd).toBe("/repo");
        expect(p.kind).toBe("terminal");
        expect(p.title).toBe("shell");

        expect(makePane("/repo", { kind: "editor" }).title).toBe("editor");
        expect(makePane("/repo", { startup: "top" }).title).toBe("top");
    });

    it("collects panes from nested trees in render order", () => {
        const tree: LayoutNode = {
            type: "split",
            id: "s1",
            dir: "row",
            sizes: [0.6, 0.4],
            children: [pane("a"), { type: "split", id: "s2", dir: "column", sizes: [0.5, 0.5], children: [pane("b"), pane("c")] }],
        };

        expect(collectPanes(tree).map((p) => p.id)).toEqual(["a", "b", "c"]);
    });

    it("splits a pane into a new split", () => {
        const root = pane("a");
        const next = splitPane(root, "a", "row", pane("b"));

        expect(next.type).toBe("split");
        if (next.type !== "split") throw new Error("expected split");
        expect(next.dir).toBe("row");
        expect(next.sizes).toEqual([0.5, 0.5]);
        expect(next.children.map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("adds a pane beside an existing same-axis split and halves the target pane", () => {
        const root: LayoutNode = { type: "split", id: "s1", dir: "row", sizes: [0.7, 0.3], children: [pane("a"), pane("c")] };
        const next = splitPane(root, "a", "row", pane("b"));

        expect(next.type).toBe("split");
        if (next.type !== "split") throw new Error("expected split");
        expect(next.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
        expect(next.sizes).toEqual([0.35, 0.35, 0.3]);
    });

    it("removes panes and collapses single-child splits", () => {
        const root: LayoutNode = { type: "split", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [pane("a"), pane("b")] };

        expect(removePane(root, "missing")).toEqual(root);
        expect(removePane(root, "a")).toEqual(pane("b"));
        expect(removePane(pane("a"), "a")).toBeNull();
    });

    it("computes row and column rectangles", () => {
        const root: LayoutNode = {
            type: "split",
            id: "s1",
            dir: "row",
            sizes: [0.25, 0.75],
            children: [pane("left"), { type: "split", id: "s2", dir: "column", sizes: [0.4, 0.6], children: [pane("top"), pane("bottom")] }],
        };

        const { panes, dividers } = computeLayout(root);
        expect(panes.get("left")).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
        expect(panes.get("top")).toEqual({ x: 0.25, y: 0, w: 0.75, h: 0.4 });
        expect(panes.get("bottom")).toEqual({ x: 0.25, y: 0.4, w: 0.75, h: 0.6 });
        expect(dividers).toHaveLength(2);
    });

    it("finds directional neighbours by geometry", () => {
        const root: LayoutNode = {
            type: "split",
            id: "s1",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [pane("left"), { type: "split", id: "s2", dir: "column", sizes: [0.5, 0.5], children: [pane("top"), pane("bottom")] }],
        };
        const { panes } = computeLayout(root);

        expect(neighborPane(panes, "left", "right")).toBe("top");
        expect(neighborPane(panes, "top", "left")).toBe("left");
        expect(neighborPane(panes, "bottom", "up")).toBe("top");
        expect(neighborPane(panes, "top", "down")).toBe("bottom");
    });

    it("updates split sizes and resizes without violating minimum pane size", () => {
        const root: LayoutNode = { type: "split", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [pane("a"), pane("b")] };
        expect(setSplitSizes(root, "s1", [0.25, 0.75])).toMatchObject({ sizes: [0.25, 0.75] });

        const resized = resizeTowards(root, "a", "right", 0.7);
        expect(resized.type).toBe("split");
        if (resized.type !== "split") throw new Error("expected split");
        expect(resized.sizes[0]).toBeCloseTo(1 - MIN_FRAC);
        expect(resized.sizes[1]).toBeCloseTo(MIN_FRAC);
    });
});
