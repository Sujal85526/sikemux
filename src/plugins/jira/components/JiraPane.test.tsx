import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraIssue, JiraStatus } from "../api";

const api = vi.hoisted(() => ({
    status: vi.fn(),
    search: vi.fn(),
    issue: vi.fn(),
    filters: vi.fn(),
    comment: vi.fn(),
    transition: vi.fn(),
    assign: vi.fn(),
    setTask: vi.fn(),
    projects: vi.fn(),
    boards: vi.fn(),
    board: vi.fn(),
    moveIssue: vi.fn(),
    signIn: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), jiraApi: api }));
const host = vi.hoisted(() => ({ copyText: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../../plugin-api/host", async (importOriginal) => ({ ...(await importOriginal<object>()), ...host }));

import { JiraPane } from "./JiraPane";
import { invalidate } from "../../../plugin-api/resources";

const signedIn: JiraStatus = {
    configured: true,
    sites: [{ host: "acme.atlassian.net", displayName: "Me", default: true }],
    ok: true,
    authFailed: false,
    message: null,
    browserSignIn: false,
};

const summary = {
    key: "ABC-12",
    summary: "Fix the login race",
    status: "In Progress",
    statusCategory: "indeterminate" as const,
    priority: "High",
    assignee: { accountId: "a1", name: "Ana" },
    issueType: "Bug",
    sprint: "Sprint 5",
    updated: null,
    url: "https://acme.atlassian.net/browse/ABC-12",
};

const detail: JiraIssue = {
    ...summary,
    project: "ABC",
    reporter: { accountId: "r1", name: "Raj" },
    labels: ["auth"],
    created: null,
    description: "Steps: **open** the app",
    comments: [{ id: "1", author: "Raj", created: "2026-10-04T09:00:00.000+0000", body: "Seen on staging" }],
    commentCount: 1,
    transitions: [{ id: "31", name: "Review", to: "In Review" }],
};

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("jira."));
});

beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.status.mockResolvedValue(signedIn);
    api.search.mockResolvedValue({ issues: [summary], next: null });
    api.filters.mockResolvedValue([{ id: "9", name: "Team bugs", jql: "type = Bug" }]);
    api.issue.mockResolvedValue(detail);
    api.comment.mockResolvedValue({ id: "2", author: "Me", created: "", body: "Fixed" });
    api.transition.mockResolvedValue({ status: "In Review", transitions: [] });
    api.projects.mockResolvedValue([
        { key: "ABC", name: "Alphabet" },
        { key: "OPS", name: "Operations" },
    ]);
    api.boards.mockResolvedValue([{ id: 7, name: "ABC board", kind: "scrum", project: "ABC" }]);
    api.board.mockResolvedValue({
        id: 7,
        name: "ABC board",
        kind: "scrum",
        sprint: { id: 42, name: "Sprint 5", end: null, goal: "Ship the login fix" },
        columns: [
            { name: "To Do", statusIds: ["1"], issues: [] },
            { name: "In Progress", statusIds: ["3"], issues: [summary] },
            { name: "Done", statusIds: ["4"], issues: [] },
        ],
        truncated: false,
    });
    api.moveIssue.mockResolvedValue(undefined);
});

describe("JiraPane", () => {
    it("asks for a sign-in when no site is signed in", async () => {
        api.status.mockResolvedValue({ configured: false, sites: [], ok: false, authFailed: false, message: null });
        render(<JiraPane paneId="jira-signed-out" active />);
        expect(await screen.findByText("Connect Jira")).toBeInTheDocument();
    });

    it("lists my issues and starred filters, and opens an issue with its description and comments", async () => {
        render(<JiraPane paneId="jira-list" active />);
        const row = await screen.findByRole("listitem");
        expect(api.search).toHaveBeenCalledWith(expect.stringContaining("assignee = currentUser()"), "acme.atlassian.net");
        expect(row).toHaveTextContent("ABC-12");
        expect(row).toHaveTextContent("Fix the login race");
        expect(await screen.findByRole("button", { name: "Team bugs" })).toBeInTheDocument();

        fireEvent.click(row);

        expect(await screen.findByRole("heading", { name: "Fix the login race" })).toBeInTheDocument();
        expect(await screen.findByText(/Steps:/)).toBeInTheDocument();
        expect(await screen.findByText("Seen on staging")).toBeInTheDocument();
    });

    it("opens an issue in the browser or copies its link from the header", async () => {
        host.copyText.mockResolvedValue(undefined);
        host.openUrl.mockResolvedValue(undefined);
        render(<JiraPane paneId="jira-links" active />);
        fireEvent.click(await screen.findByRole("listitem"));
        fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
        expect(host.copyText).toHaveBeenCalledWith("https://acme.atlassian.net/browse/ABC-12");
        fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
        expect(host.openUrl).toHaveBeenCalledWith("https://acme.atlassian.net/browse/ABC-12");
    });

    it("offers the same on a right-click of a listed issue, without opening it", async () => {
        host.copyText.mockResolvedValue(undefined);
        render(<JiraPane paneId="jira-row-menu" active />);
        fireEvent.contextMenu(await screen.findByRole("listitem"));
        fireEvent.click(screen.getByText("Copy key and title"));
        expect(host.copyText).toHaveBeenCalledWith("ABC-12 Fix the login race");
        expect(api.issue).not.toHaveBeenCalled();
    });

    it("ticks a task in the description in Jira, and says so when Jira refuses", async () => {
        api.issue.mockResolvedValue({ ...detail, description: "Acceptance:\n\n- [ ] Sends when **long**\n- [x] Keeps the 400" });
        api.setTask.mockResolvedValue(undefined);
        render(<JiraPane paneId="jira-tasks" active />);
        fireEvent.click(await screen.findByRole("listitem"));
        const [first, second] = await screen.findAllByRole("checkbox");
        expect(first).not.toBeChecked();
        expect(second).toBeChecked();

        await act(async () => fireEvent.click(first));
        expect(api.setTask).toHaveBeenCalledWith("ABC-12", 0, "Sends when long", true, "acme.atlassian.net");

        api.setTask.mockRejectedValue({ category: "not-found", message: "ABC-12 changed in Jira since it was opened" });
        await act(async () => fireEvent.click(second));
        expect(api.setTask).toHaveBeenLastCalledWith("ABC-12", 1, "Keeps the 400", false, "acme.atlassian.net");
        expect(second).toBeChecked();
    });

    it("lists what I reported, watch and viewed, and a project's open and unassigned issues", async () => {
        render(<JiraPane paneId="jira-more-lists" active />);
        fireEvent.click(await screen.findByRole("button", { name: "Reported by me" }));
        await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.stringContaining("reporter = currentUser()"), "acme.atlassian.net"));
        fireEvent.click(screen.getByRole("button", { name: "Watching" }));
        await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.stringContaining("watcher = currentUser()"), "acme.atlassian.net"));
        fireEvent.click(screen.getByRole("button", { name: "Recently viewed" }));
        await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.stringContaining("issueHistory()"), "acme.atlassian.net"));
        fireEvent.click(await screen.findByRole("button", { name: "Unassigned" }));
        await waitFor(() =>
            expect(api.search).toHaveBeenLastCalledWith(expect.stringContaining('project = "ABC" AND assignee is EMPTY'), "acme.atlassian.net"),
        );
    });

    it("opens a board with its sprint and columns, and moves a card to another column", async () => {
        render(<JiraPane paneId="jira-board" active />);
        fireEvent.click(await screen.findByRole("button", { name: "ABC board" }));
        expect(await screen.findByRole("region", { name: "ABC board" })).toHaveTextContent("Sprint 5");
        expect(screen.getByText("Ship the login fix")).toBeInTheDocument();
        const progress = screen.getByRole("list", { name: "In Progress" });
        expect(progress).toHaveTextContent("Fix the login race");

        fireEvent.contextMenu(screen.getByRole("listitem"));
        await act(async () => fireEvent.click(screen.getByText("Move to Done")));
        expect(api.moveIssue).toHaveBeenCalledWith("ABC-12", expect.objectContaining({ name: "Done", statusIds: ["4"] }), "acme.atlassian.net");

        fireEvent.click(screen.getByRole("listitem"));
        expect(await screen.findByRole("heading", { name: "Fix the login race" })).toBeInTheDocument();
    });

    it("puts a card back and says why when Jira will not move it", async () => {
        api.moveIssue.mockRejectedValue({ category: "bad-params", message: "ABC-12's workflow has no way into Done from where it is now" });
        render(<JiraPane paneId="jira-board-refused" active />);
        fireEvent.click(await screen.findByRole("button", { name: "ABC board" }));
        fireEvent.contextMenu(await screen.findByRole("listitem"));
        await act(async () => fireEvent.click(screen.getByText("Move to Done")));
        expect(screen.getByRole("list", { name: "In Progress" })).toHaveTextContent("Fix the login race");
    });

    it("comments in markdown and shows the sprint list on request", async () => {
        render(<JiraPane paneId="jira-comment" active />);
        fireEvent.click(await screen.findByRole("listitem"));
        await screen.findByRole("heading", { name: "Fix the login race" });

        fireEvent.change(screen.getByPlaceholderText("Add a comment in markdown"), { target: { value: "Fixed in **#12**" } });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Comment" })));
        expect(api.comment).toHaveBeenCalledWith("ABC-12", "Fixed in **#12**", "acme.atlassian.net");

        fireEvent.click(screen.getByRole("button", { name: "Current sprint" }));
        await waitFor(() => expect(api.search).toHaveBeenCalledWith(expect.stringContaining("sprint in openSprints()"), "acme.atlassian.net"));
    });
});
