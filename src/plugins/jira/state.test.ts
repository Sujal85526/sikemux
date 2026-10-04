import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jqlOf, MINE_JQL, SPRINT_JQL, updateJiraView, useJiraView } from "./state";

describe("the Jira pane's lists", () => {
    it("asks Jira for the right issues for each list", () => {
        expect(jqlOf({ kind: "mine" })).toBe(MINE_JQL);
        expect(jqlOf({ kind: "sprint" })).toBe(SPRINT_JQL);
        expect(jqlOf({ kind: "filter", id: "1", name: "Bugs", jql: "type = Bug" })).toBe("type = Bug");
        expect(jqlOf({ kind: "jql", jql: "project = ABC" })).toBe("project = ABC");
    });

    it("remembers each pane's list and open issue on its own, starting on my issues", () => {
        updateJiraView("pane-a", { issue: "ABC-1" });
        updateJiraView("pane-b", { list: { kind: "sprint" } });
        const a = renderHook(() => useJiraView("pane-a")).result.current;
        const b = renderHook(() => useJiraView("pane-b")).result.current;
        const fresh = renderHook(() => useJiraView("pane-c")).result.current;
        expect(a).toEqual({ list: { kind: "mine" }, issue: "ABC-1", site: "" });
        expect(b).toEqual({ list: { kind: "sprint" }, issue: null, site: "" });
        expect(fresh.list).toEqual({ kind: "mine" });
    });
});
