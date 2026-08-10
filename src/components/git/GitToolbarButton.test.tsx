import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitToolbarButton } from "./GitToolbarButton";

describe("GitToolbarButton", () => {
    it("renders icon, label, count and keyboard hint", () => {
        const onClick = vi.fn();
        render(
            <GitToolbarButton
                ariaControls="details"
                ariaExpanded
                icon={<span data-testid="icon">i</span>}
                count={2}
                kbd="P"
                title="Push"
                onClick={onClick}>
                Push
            </GitToolbarButton>,
        );

        expect(screen.getByTestId("icon")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("P")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: /push/i });
        expect(button).toHaveAttribute("aria-controls", "details");
        expect(button).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
