import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitPane } from "./SplitPane";

afterEach(cleanup);

/* jsdom lays nothing out, so the box the ratio is measured against has to be
   stated for the maths to have anything to work with. */
function withWidth(width: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width,
        height: 600,
    } as DOMRect);
}

describe("SplitPane", () => {
    it("draws no handle until there is a second pane", () => {
        const { rerender } = render(<SplitPane ratio={0.5} onRatio={() => {}}>left</SplitPane>);
        expect(screen.queryByRole("separator")).not.toBeInTheDocument();

        rerender(
            <SplitPane ratio={0.5} onRatio={() => {}} end={<div>right</div>}>
                left
            </SplitPane>,
        );
        expect(screen.getByRole("separator")).toBeInTheDocument();
    });

    it("reports the ratio the pointer was dragged to", () => {
        withWidth(1000);
        const onRatio = vi.fn();
        render(
            <SplitPane ratio={0.5} onRatio={onRatio} min={100} end={<div>right</div>}>
                left
            </SplitPane>,
        );
        const handle = screen.getByRole("separator");
        handle.setPointerCapture = vi.fn();

        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerMove(window, { clientX: 300 });

        expect(onRatio).toHaveBeenCalledWith(0.3);
    });

    it("keeps either pane above its minimum", () => {
        withWidth(1000);
        const onRatio = vi.fn();
        render(
            <SplitPane ratio={0.5} onRatio={onRatio} min={320} end={<div>right</div>}>
                left
            </SplitPane>,
        );
        const handle = screen.getByRole("separator");
        handle.setPointerCapture = vi.fn();

        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerMove(window, { clientX: 10 });
        expect(onRatio.mock.lastCall?.[0]).toBeCloseTo(0.32, 5);

        fireEvent.pointerMove(window, { clientX: 990 });
        expect(onRatio.mock.lastCall?.[0]).toBeCloseTo(0.68, 5);
    });

    it("moves on the arrow keys, so the handle is reachable without a pointer", () => {
        withWidth(1000);
        const onRatio = vi.fn();
        render(
            <SplitPane ratio={0.5} onRatio={onRatio} end={<div>right</div>}>
                left
            </SplitPane>,
        );
        const handle = screen.getByRole("separator");

        fireEvent.keyDown(handle, { key: "ArrowRight" });
        expect(onRatio.mock.lastCall?.[0]).toBeCloseTo(0.52, 5);

        fireEvent.keyDown(handle, { key: "ArrowLeft" });
        expect(onRatio.mock.lastCall?.[0]).toBeCloseTo(0.48, 5);
    });

    it("resizes down the other axis when stacked", () => {
        withWidth(1000);
        const onRatio = vi.fn();
        render(
            <SplitPane ratio={0.5} onRatio={onRatio} orientation="column" min={100} end={<div>bottom</div>}>
                top
            </SplitPane>,
        );
        const handle = screen.getByRole("separator");
        handle.setPointerCapture = vi.fn();
        expect(handle).toHaveAttribute("aria-orientation", "horizontal");

        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerMove(window, { clientY: 150 });

        expect(onRatio).toHaveBeenCalledWith(0.25);
    });
});
