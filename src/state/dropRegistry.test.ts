import { afterEach, describe, expect, it, vi } from "vitest";
import {
    dispatchPathDrop,
    focusedPathDropTarget,
    pathDropTargetAt,
    registerPathDrop,
    resolvePathDropTarget,
    showPathDropHover,
} from "./dropRegistry";

function paneAt(box: { x: number; y: number; width: number; height: number }): HTMLDivElement {
    const pane = document.createElement("div");
    pane.getBoundingClientRect = () =>
        ({
            x: box.x,
            y: box.y,
            left: box.x,
            top: box.y,
            right: box.x + box.width,
            bottom: box.y + box.height,
            width: box.width,
            height: box.height,
        }) as DOMRect;
    document.body.append(pane);
    return pane;
}

async function dropPointOn(platform: "windows" | "mac", devicePixelRatio: number) {
    vi.resetModules();
    vi.doMock("../lib/platform", () => ({ IS_WINDOWS: platform === "windows", IS_MACOS: platform === "mac" }));
    vi.stubGlobal("devicePixelRatio", devicePixelRatio);
    const { nativeDropPoint } = await import("./dropRegistry");
    return nativeDropPoint;
}

describe("native drag position", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock("../lib/platform");
        vi.resetModules();
    });

    it("keeps a macOS position as it arrives, retina or not", async () => {
        const point = await dropPointOn("mac", 2);
        expect(point({ x: 900, y: 600 })).toEqual({ x: 900, y: 600 });
    });

    it("brings a Windows position down out of device pixels", async () => {
        const point = await dropPointOn("windows", 2);
        expect(point({ x: 900, y: 600 })).toEqual({ x: 450, y: 300 });
    });

    it("converts a position that lands outside the window", async () => {
        const point = await dropPointOn("mac", 2);
        expect(point({ x: 1800, y: 1200 })).toEqual({ x: 900, y: 600 });
    });
});

describe("native path drop registry", () => {
    it("routes a hit-tested descendant to its nearest registered owner", () => {
        const outer = document.createElement("div");
        const target = document.createElement("div");
        const textarea = document.createElement("textarea");
        outer.append(target);
        target.append(textarea);
        const handler = vi.fn();
        const unregister = registerPathDrop(target, handler);

        expect(resolvePathDropTarget(textarea)).toBe(target);
        expect(dispatchPathDrop(textarea, ["/tmp/screenshot.png"])).toBe(true);
        expect(handler).toHaveBeenCalledWith(["/tmp/screenshot.png"]);

        unregister();
        expect(resolvePathDropTarget(textarea)).toBeNull();
        expect(dispatchPathDrop(textarea, ["/tmp/screenshot.png"])).toBe(false);
    });

    it("does not let stale cleanup remove a replacement handler", () => {
        const target = document.createElement("div");
        const first = vi.fn();
        const second = vi.fn();
        const unregisterFirst = registerPathDrop(target, first);
        const unregisterSecond = registerPathDrop(target, second);

        unregisterFirst();
        expect(dispatchPathDrop(target, ["/tmp/new.png"])).toBe(true);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith(["/tmp/new.png"]);

        unregisterSecond();
        expect(dispatchPathDrop(target, ["/tmp/new.png"])).toBe(false);
    });
});

describe("a drop the hit test missed", () => {
    afterEach(() => {
        showPathDropHover(null);
        document.body.replaceChildren();
    });

    it("lands in the innermost pane the cursor was over", () => {
        const outer = paneAt({ x: 0, y: 0, width: 1000, height: 800 });
        const inner = paneAt({ x: 400, y: 0, width: 600, height: 800 });
        const elsewhere = paneAt({ x: 0, y: 0, width: 0, height: 0 });
        const unregister = [outer, inner, elsewhere].map((pane) => registerPathDrop(pane, vi.fn()));

        expect(pathDropTargetAt({ x: 500, y: 300 })).toBe(inner);
        expect(pathDropTargetAt({ x: 100, y: 300 })).toBe(outer);
        expect(pathDropTargetAt({ x: 2000, y: 300 })).toBeNull();

        for (const off of unregister) off();
        expect(pathDropTargetAt({ x: 500, y: 300 })).toBeNull();
    });

    it("ignores a pane that is on screen but hidden", () => {
        const pane = paneAt({ x: 0, y: 0, width: 1000, height: 800 });
        pane.style.visibility = "hidden";
        const unregister = registerPathDrop(pane, vi.fn());

        expect(pathDropTargetAt({ x: 100, y: 100 })).toBeNull();
        unregister();
    });

    it("falls back to the session last typed in", () => {
        const chat = paneAt({ x: 0, y: 0, width: 600, height: 800 });
        const editor = document.createElement("textarea");
        chat.append(editor);
        const unregister = registerPathDrop(chat, vi.fn());

        editor.focus();
        expect(focusedPathDropTarget()).toBe(chat);

        editor.blur();
        expect(focusedPathDropTarget()).toBe(chat);

        unregister();
        expect(focusedPathDropTarget()).toBeNull();
    });

    it("marks one pane at a time while a drag is aimed at it", () => {
        const first = paneAt({ x: 0, y: 0, width: 600, height: 800 });
        const second = paneAt({ x: 600, y: 0, width: 600, height: 800 });

        showPathDropHover(first);
        expect(first.dataset.nativePathDragOver).toBe("true");

        showPathDropHover(second);
        expect(first.dataset.nativePathDragOver).toBeUndefined();
        expect(second.dataset.nativePathDragOver).toBe("true");

        showPathDropHover(null);
        expect(second.dataset.nativePathDragOver).toBeUndefined();
    });
});
