import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";

const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getVirtualItems: () =>
            Array.from({ length: Math.min(count, 12) }, (_, index) => ({ index, key: index, start: index * 160, size: 160, end: (index + 1) * 160 })),
        getTotalSize: () => count * 160,
        measureElement: vi.fn(),
        scrollToIndex,
    }),
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const strip = (count: number, activeIndex: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `tab-${index}`, label: `Tab ${index}`, active: index === activeIndex }));

it("mounts a bounded window for a large tab strip and navigates by full-list index", () => {
    const onSelect = vi.fn();
    render(<TabBar variant="agent" tabs={strip(100, 0)} onSelect={onSelect} />);

    expect(screen.getAllByRole("tab")).toHaveLength(12);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Tab 0" }), { key: "End" });
    expect(onSelect).toHaveBeenCalledWith("tab-99");
    expect(scrollToIndex).toHaveBeenLastCalledWith(99, { align: "auto" });
});

/*
 * A strip too narrow for its tabs used to leave the active pill off the end of
 * itself unless it was long enough to be virtualized, so the tab you were on
 * could be somewhere you could not see.
 */
it("brings the active pill into view whichever tab becomes active", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(<TabBar variant="agent" tabs={strip(3, 0)} onSelect={vi.fn()} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockClear();

    rerender(<TabBar variant="agent" tabs={strip(3, 2)} onSelect={vi.fn()} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest", inline: "nearest" });
});

it("brings it into view on a virtualized strip too", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(<TabBar variant="agent" tabs={strip(100, 0)} onSelect={vi.fn()} />);
    scrollIntoView.mockClear();

    rerender(<TabBar variant="agent" tabs={strip(100, 5)} onSelect={vi.fn()} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest", inline: "nearest" });
});

it("jumps rather than glides when motion is reduced", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    render(<TabBar variant="agent" tabs={strip(3, 1)} onSelect={vi.fn()} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "nearest", inline: "nearest" });
    vi.unstubAllGlobals();
});
