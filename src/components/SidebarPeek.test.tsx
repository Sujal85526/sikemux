import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarPeek } from "./SidebarPeek";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("SidebarPeek", () => {
    it("mounts the rail on edge hover and removes it after the exit animation", () => {
        vi.useFakeTimers();
        render(
            <SidebarPeek side="left">
                <aside>sessions</aside>
            </SidebarPeek>,
        );

        const peek = screen.getByTestId("sidebar-peek-left");
        expect(screen.queryByText("sessions")).not.toBeInTheDocument();

        fireEvent.pointerEnter(peek);
        expect(screen.getByText("sessions")).toBeInTheDocument();
        expect(screen.getByText("sessions").parentElement).toHaveClass("sidebar-peek-panel--open");

        fireEvent.pointerLeave(peek);
        expect(screen.getByText("sessions").parentElement).toHaveClass("sidebar-peek-panel--closing");

        act(() => vi.advanceTimersByTime(180));
        expect(screen.queryByText("sessions")).not.toBeInTheDocument();
    });

    it("cancels a pending close when the pointer returns", () => {
        vi.useFakeTimers();
        render(
            <SidebarPeek side="right">
                <aside>agents</aside>
            </SidebarPeek>,
        );

        const peek = screen.getByTestId("sidebar-peek-right");
        fireEvent.pointerEnter(peek);
        fireEvent.pointerLeave(peek);
        fireEvent.pointerEnter(peek);
        act(() => vi.advanceTimersByTime(180));

        expect(screen.getByText("agents").parentElement).toHaveClass("sidebar-peek-panel--open");
    });
});
