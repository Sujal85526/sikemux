import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitFile } from "../api/git";

vi.mock("./DiffEditor", () => ({
    DiffEditor: ({ path, baseRev, headRev, editable }: { path: string; baseRev: string; headRev?: string; editable: boolean }) => (
        <div data-testid={`diff:${path}:${baseRev}:${headRev ?? "working"}`} data-editable={editable} />
    ),
}));

import { MergeReview } from "./MergeReview";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const files: GitFile[] = [
    { path: "staged.ts", index: "M", worktree: " " },
    { path: "both.ts", index: "M", worktree: "M" },
    { path: "working.ts", index: " ", worktree: "M" },
];

describe("MergeReview", () => {
    it("renders every changed file in one collapsible stream", () => {
        render(<MergeReview repo="/repo" files={files} onOpenFile={() => {}} onSaved={() => {}} />);

        expect(screen.getByText("3 files · 3 expanded")).toBeInTheDocument();
        expect(screen.getByTestId("diff:staged.ts:HEAD::index")).toBeInTheDocument();
        expect(screen.getByTestId("diff:both.ts:HEAD::index")).toBeInTheDocument();
        expect(screen.getByTestId("diff:both.ts::index:working")).toBeInTheDocument();
        expect(screen.getByTestId("diff:working.ts:HEAD:working")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Collapse both.ts" }));
        expect(screen.getByText("3 files · 2 expanded")).toBeInTheDocument();
        expect(screen.queryByTestId("diff:both.ts:HEAD::index")).not.toBeInTheDocument();
        expect(screen.queryByTestId("diff:both.ts::index:working")).not.toBeInTheDocument();
        expect(screen.getByTestId("diff:staged.ts:HEAD::index")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "collapse all" }));
        expect(screen.getByText("3 files · 0 expanded")).toBeInTheDocument();
        expect(screen.queryByTestId("diff:staged.ts:HEAD::index")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "expand all" }));
        expect(screen.getByText("3 files · 3 expanded")).toBeInTheDocument();
        expect(screen.getByTestId("diff:working.ts:HEAD:working")).toBeInTheDocument();
    });

    it("keeps file names wired to the editor", () => {
        const onOpenFile = vi.fn();
        render(<MergeReview repo="/repo" files={files} onOpenFile={onOpenFile} onSaved={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "staged.ts" }));
        expect(onOpenFile).toHaveBeenCalledWith("/repo/staged.ts");
    });

    it("mounts only the selected and near-viewport diff bodies", () => {
        const observed: Element[] = [];
        let callback: IntersectionObserverCallback | undefined;
        class MockIntersectionObserver {
            constructor(next: IntersectionObserverCallback) {
                callback = next;
            }
            observe(element: Element) {
                observed.push(element);
            }
            unobserve(element: Element) {
                const index = observed.indexOf(element);
                if (index >= 0) observed.splice(index, 1);
            }
            disconnect() {
                observed.length = 0;
            }
        }
        vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

        render(<MergeReview repo="/repo" files={files} focusPath="working.ts" onOpenFile={() => {}} onSaved={() => {}} />);

        expect(screen.getByTestId("diff:working.ts:HEAD:working")).toHaveAttribute("data-editable", "true");
        expect(screen.queryByTestId("diff:staged.ts:HEAD::index")).not.toBeInTheDocument();
        expect(screen.queryByTestId("diff:both.ts:HEAD::index")).not.toBeInTheDocument();
        expect(observed).toHaveLength(2);

        const target = observed[0];
        act(() => callback?.([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));

        expect(screen.getByTestId("diff:staged.ts:HEAD::index")).toHaveAttribute("data-editable", "false");
        expect(screen.queryByTestId("diff:both.ts:HEAD::index")).not.toBeInTheDocument();

        act(() => callback?.([{ target, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
        expect(screen.queryByTestId("diff:staged.ts:HEAD::index")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Diff for staged.ts loads when scrolled near")).toBeInTheDocument();
    });
});
