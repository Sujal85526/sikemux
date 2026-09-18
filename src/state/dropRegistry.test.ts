import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPathDrop, registerPathDrop, resolvePathDropTarget } from "./dropRegistry";

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
