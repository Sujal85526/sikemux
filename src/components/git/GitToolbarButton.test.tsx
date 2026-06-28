import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitToolbarButton } from "./GitToolbarButton";

describe("GitToolbarButton", () => {
    it("renders icon, label, count and keyboard hint", () => {
        const onClick = vi.fn();
        render(
            <GitToolbarButton icon={<span data-testid="icon">i</span>} count={2} kbd="P" title="Push" onClick={onClick}>
                Push
            </GitToolbarButton>,
        );

        expect(screen.getByTestId("icon")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("P")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /push/i }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
