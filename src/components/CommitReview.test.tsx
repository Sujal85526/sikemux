import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { commitFiles } = vi.hoisted(() => ({ commitFiles: vi.fn() }));
vi.mock("../api/git", () => ({ git: { commitFiles } }));
vi.mock("./DiffEditor", () => ({ DiffEditor: () => null }));

import { CommitReview } from "./CommitReview";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe("CommitReview", () => {
    it("ignores a stale commit-files result after the revision changes", async () => {
        const oldReq = deferred<string[]>();
        const newReq = deferred<string[]>();
        commitFiles.mockReset().mockReturnValueOnce(oldReq.promise).mockReturnValueOnce(newReq.promise);
        const { rerender } = render(<CommitReview repo="/repo" rev="old" title="old" subtitle="" onOpenFile={() => {}} />);
        rerender(<CommitReview repo="/repo" rev="new" title="new" subtitle="" onOpenFile={() => {}} />);

        await act(async () => newReq.resolve(["new.ts"]));
        expect(screen.getByText("new.ts")).toBeInTheDocument();
        await act(async () => oldReq.resolve(["old.ts"]));
        expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
        expect(screen.getByText("new.ts")).toBeInTheDocument();
    });
});
