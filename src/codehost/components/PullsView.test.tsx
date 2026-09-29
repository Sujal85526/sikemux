import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pull } from "../api";

const api = vi.hoisted(() => ({
    pulls: vi.fn(),
    pull: vi.fn(),
    pullReviews: vi.fn(() => Promise.resolve([])),
    timeline: vi.fn(() => Promise.resolve([])),
    pullCommits: vi.fn(),
    pullFiles: vi.fn(),
    runs: vi.fn(() => Promise.resolve({ runs: [], total: 0 })),
    branches: vi.fn(() => Promise.resolve(["main", "feat/run-page"])),
    createPull: vi.fn(() => Promise.resolve({ number: 32 })),
}));

const localGit = vi.hoisted(() => ({
    compare: vi.fn(),
    push: vi.fn(),
}));

vi.mock("../../api/git", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api/git")>()), git: localGit }));

vi.mock("../../components/CommitReview", () => ({
    CommitReview: ({ rev, range }: { rev: string; range?: { base: string; files: string[] } }) => (
        <div data-testid="commit-review">{range ? `${range.base}..${rev} ${range.files.join(" ")}` : rev}</div>
    ),
}));

import { invalidate } from "../../plugin-api/resources";
import { setState } from "../../state/store";
import { resetView, showItem } from "../state";
import { InHost, registerTestHost, TEST_HOST } from "../testHost";
import { PullsView } from "./PullsView";

const host = registerTestHost(api);
const repo = { provider: TEST_HOST, owner: "nodelike", name: "sikemux" };

const pull: Pull = {
    number: 31,
    title: "the run page",
    body: "Brings the run page up to what GitHub shows.",
    state: "open",
    draft: false,
    author: "someone",
    avatarUrl: null,
    authorAssociation: null,
    head: "feat/run-page",
    headLabel: null,
    base: "main",
    headSha: null,
    createdAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    comments: 0,
    additions: 3,
    deletions: 0,
    changedFiles: 1,
    mergeable: true,
    mergeState: "clean",
    labels: [],
    reviewers: [],
    assignees: [],
    milestone: null,
    commits: 2,
    mergedAt: null,
    mergedBy: null,
    mergeCommitSha: null,
    avatars: {},
    url: "https://example.test/pull/31",
};

beforeEach(() => {
    invalidate(() => true);
    resetView("p-git");
    setState({ gitViews: {} });
    api.pulls.mockResolvedValue([pull]);
    api.pull.mockResolvedValue(pull);
    api.pullCommits.mockResolvedValue([
        { sha: "aaaaaaa1111111", message: "feat: first", author: "someone", avatarUrl: null, date: "2026-01-01T10:00:00Z" },
        { sha: "bbbbbbb2222222", message: "feat: second\n\nwith a body", author: "someone", avatarUrl: null, date: "2026-01-01T11:00:00Z" },
    ]);
    api.pullFiles.mockResolvedValue([
        { path: "src/run.ts", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+x", previousPath: null },
    ]);
});
afterEach(cleanup);

const view = (item: number | null, composing = false, projectBranch = "main") => (
    <InHost host={host}>
        <PullsView
            paneId="p-git"
            repo={repo}
            listState="open"
            item={item}
            composing={composing}
            projectBranch={projectBranch}
            cwd="/repo"
            login="me"
            active
        />
    </InHost>
);

it("reads a pull request in the git pane's columns: its card and files on the left, the conversation on the right", async () => {
    const user = userEvent.setup();
    render(view(31));
    expect((await screen.findAllByRole("heading", { name: /the run page/ })).length).toBeGreaterThan(0);
    const left = document.querySelector(".git-left") as HTMLElement;
    const right = document.querySelector(".git-right") as HTMLElement;
    expect(within(left).getByRole("button", { name: "Merge pull request" })).toBeInTheDocument();
    expect(await within(right).findByText("Brings the run page up to what GitHub shows.")).toBeInTheDocument();
    expect(within(right).getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true");

    await user.click(await within(left).findByRole("button", { name: /run\.ts/ }));
    expect(within(right).getByRole("tab", { name: /Files changed/ })).toHaveAttribute("aria-selected", "true");
    expect(await within(right).findByText("1 file")).toBeInTheDocument();
});

it("lists the pull request's commits in the history fold, newest first, and shows one's files on the right", async () => {
    const user = userEvent.setup();
    render(view(31));
    const toggle = await screen.findByRole("button", { name: /^Commits/ });
    await waitFor(() => expect(toggle).toHaveTextContent("2"));
    expect(toggle).toHaveTextContent("feat: second");

    await user.click(toggle);
    const rows = await screen.findAllByRole("button", { name: /feat: / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["bbbbbbb feat: second", "aaaaaaa feat: first"]);

    await user.click(rows[1]);
    expect(await screen.findByTestId("commit-review")).toHaveTextContent("aaaaaaa1111111");
});

it("gives the list the whole pane while nothing is open", async () => {
    render(view(null));
    expect(await screen.findByText("the run page")).toBeInTheDocument();
    expect(document.querySelector(".gha-full-page .pr-list")).toBeInTheDocument();
    expect(document.querySelector(".git-right")).not.toBeInTheDocument();
    showItem("p-git", null);
});

it("writes a new pull request beside the branch's diff, with its title taken from its only commit", async () => {
    const user = userEvent.setup();
    localGit.compare.mockResolvedValue({
        merge_base: "base000",
        files: [{ path: "src/run.ts", status: "A" }],
        commits: [
            {
                hash: "ccccccc",
                full_hash: "ccccccc3333333",
                parents: ["base000"],
                author: "me",
                author_email: "me@example.test",
                date: "now",
                subject: "feat: the run page",
                refs: [],
                unpushed: false,
            },
        ],
    });
    render(view(null, true, "feat/run-page"));

    const left = document.querySelector(".git-left") as HTMLElement;
    const right = document.querySelector(".git-right") as HTMLElement;
    expect(await within(left).findByRole("button", { name: /run\.ts/ })).toBeInTheDocument();
    await waitFor(() => expect(within(left).getByLabelText("Title")).toHaveValue("feat: the run page"));
    expect(localGit.compare).toHaveBeenCalledWith("/repo", "main", "feat/run-page");
    expect(within(right).getByTestId("commit-review")).toHaveTextContent("base000..feat/run-page src/run.ts");

    await user.click(within(left).getByRole("button", { name: "Open pull request" }));
    await waitFor(() =>
        expect(api.createPull).toHaveBeenCalledWith(repo, {
            title: "feat: the run page",
            head: "feat/run-page",
            base: "main",
            body: "",
            draft: false,
        }),
    );
});
