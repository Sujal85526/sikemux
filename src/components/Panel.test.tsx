import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, EmptyState, Panel, PanelBody, PanelHeader, PanelRow, PanelRowHint } from "./Panel";

afterEach(cleanup);

describe("Panel", () => {
    it("focuses from the header without swallowing action clicks", () => {
        const onFocus = vi.fn();
        const onAction = vi.fn();
        render(
            <Panel focused flex={2}>
                <PanelHeader index={1} label="Files" onFocus={onFocus} actions={[{ key: "s", label: "stage", onClick: onAction }]} />
                <PanelBody>rows</PanelBody>
            </Panel>,
        );

        fireEvent.click(screen.getByText("Files"));
        expect(onFocus).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: /stage/i }));
        expect(onAction).toHaveBeenCalledTimes(1);
        // The action stops propagation so acting never also re-focuses.
        expect(onFocus).toHaveBeenCalledTimes(1);
    });

    it("is inert as a header when it labels nothing focusable", () => {
        render(<PanelHeader label="Limits" rule />);
        expect(screen.queryByRole("button", { name: /Focus Limits/ })).not.toBeInTheDocument();
    });

    it("skips falsy badges", () => {
        render(<PanelHeader label="Branches" badges={[null, <Badge tone="warn">3 selected</Badge>, false]} />);
        expect(screen.getByText("3 selected")).toHaveClass("badge", "badge-warn");
        expect(screen.getByText("Branches").parentElement?.querySelectorAll(".badge")).toHaveLength(1);
    });

    it("carries row selection and range state independently", () => {
        const { container } = render(
            <>
                <PanelRow selected>a</PanelRow>
                <PanelRow ranged>b</PanelRow>
                <PanelRow selected ranged>
                    c
                </PanelRow>
                <PanelRow muted>
                    d<PanelRowHint>HEAD</PanelRowHint>
                </PanelRow>
            </>,
        );
        const rows = [...container.querySelectorAll(".panel-row")].map((row) => row.className);
        expect(rows).toEqual(["panel-row sel", "panel-row ranged", "panel-row sel ranged", "panel-row muted"]);
        expect(screen.getByText("HEAD")).toHaveClass("panel-row-hint");
    });
});

describe("EmptyState", () => {
    it("renders title, message and an action", () => {
        const onClick = vi.fn();
        render(<EmptyState title="No remotes" message="This repository has no remotes configured yet." action={{ label: "Add remote", onClick }} />);

        expect(screen.getByText("No remotes")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Add remote" }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("announces the error tone", () => {
        render(<EmptyState tone="error" message="failed to load remotes" />);
        expect(screen.getByRole("alert")).toHaveTextContent("failed to load remotes");
    });

    it("collapses to one clickable line in the inline variant", () => {
        const onClick = vi.fn();
        const { container } = render(<EmptyState variant="inline" message="no projects" action={{ label: "add", onClick }} />);

        const button = screen.getByRole("button", { name: "no projects" });
        expect(button).toHaveClass("empty-state", "inline", "interactive");
        expect(container.querySelector(".empty-state-title")).toBeNull();
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
