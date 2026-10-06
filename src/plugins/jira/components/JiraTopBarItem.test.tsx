import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), keys: vi.fn(), search: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), jiraApi: api }));

const branch = vi.hoisted(() => ({ name: "abc-12-fix-login" }));
vi.mock("../../../plugin-api/host", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../plugin-api/host")>();
    const { resource } = await import("../../../plugin-api/resources");
    return {
        ...actual,
        gitOverviewR: resource({ kind: "test.gitOverview", fetch: async () => ({ status: { branch: branch.name } }) as never }),
    };
});

const opened = vi.hoisted(() => vi.fn());
vi.mock("../state", async (importOriginal) => ({ ...(await importOriginal<object>()), openJiraIssue: opened }));

import { invalidate } from "../../../plugin-api/resources";
import { JiraTopBarItem } from "./JiraTopBarItem";

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("jira.") || kind.startsWith("test."));
});

beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    opened.mockReset();
    api.status.mockResolvedValue({ configured: true, sites: [], ok: true, authFailed: false, message: null });
    api.keys.mockImplementation(async (text: string) => (/abc-12/i.test(text) ? ["ABC-12"] : []));
    api.search.mockResolvedValue({
        issues: [{ key: "ABC-12", summary: "Fix the login race", status: "In Progress", statusCategory: "indeterminate", url: "" }],
        next: null,
    });
});

describe("JiraTopBarItem", () => {
    it("shows the issue the branch is named after, and opens it", async () => {
        branch.name = "abc-12-fix-login";
        render(<JiraTopBarItem projectCwd="/repo" stripHovered={false} />);
        const chip = await screen.findByRole("button", { name: /ABC-12/ });
        expect(chip).toHaveTextContent("In Progress");
        expect(api.search).toHaveBeenCalledWith("key = ABC-12", undefined);

        fireEvent.click(chip);
        expect(opened).toHaveBeenCalledWith("ABC-12");
    });

    it("shows nothing on a branch without an issue key", async () => {
        branch.name = "main";
        const { container } = render(<JiraTopBarItem projectCwd="/repo" stripHovered={false} />);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(container).toBeEmptyDOMElement();
        expect(api.search).not.toHaveBeenCalled();
    });
});
