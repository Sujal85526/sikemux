import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitPanelBlock } from "./GitPanelBlock";

describe("GitPanelBlock", () => {
    it("renders title, badges, actions, and children", () => {
        const onFocus = vi.fn();
        const onAction = vi.fn();
        render(
            <GitPanelBlock
                n={2}
                label="Files"
                focused
                onFocus={onFocus}
                flex={1.5}
                rangeBadge="range 3"
                filterBadge="src"
                actions={[{ key: "a", label: "stage", onClick: onAction }]}>
                <div>body</div>
            </GitPanelBlock>,
        );

        fireEvent.click(screen.getByText("Files"));
        expect(onFocus).toHaveBeenCalledTimes(1);
        expect(screen.getByText("/src")).toBeInTheDocument();
        expect(screen.getByText("range 3")).toBeInTheDocument();
        expect(screen.getByText("body")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /stage/i }));
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(onFocus).toHaveBeenCalledTimes(1);
    });
});
