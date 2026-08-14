import { describe, expect, it, vi } from "vitest";
import { dispatchPathDrop, registerPathDrop, resolvePathDropTarget } from "./dropRegistry";

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
