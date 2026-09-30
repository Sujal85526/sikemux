import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { nativeViewsOccluded, useNativeViewHoles } from "../state/nativeViews";
import { TreeContextMenu } from "./FileTree";

describe("context menu over a browser page", () => {
    it("cuts a hole for itself instead of sending the pages away, and fills it again on close", () => {
        const holes = renderHook(() => useNativeViewHoles());
        const menu = render(<TreeContextMenu x={40} y={60} items={[{ label: "Close", run: () => {} }]} onClose={() => {}} />);

        expect(nativeViewsOccluded()).toBe(false);
        expect(holes.result.current).toEqual([expect.objectContaining({ x: 40, y: 60 })]);

        menu.unmount();
        expect(holes.result.current).toEqual([]);
    });

    it("closes when a click on the page takes the window's focus", () => {
        const onClose = vi.fn();
        render(<TreeContextMenu x={40} y={60} items={[{ label: "Close", run: () => {} }]} onClose={onClose} />);

        act(() => {
            window.dispatchEvent(new Event("blur"));
        });
        expect(onClose).toHaveBeenCalled();
    });
});
