import { create } from "zustand";
import { activeSurfacePane, onPaneClosed, openSurface } from "../../plugin-api/host";
import { JIRA_ISSUES } from "./kinds";

export type JiraList =
    { kind: "mine" } | { kind: "sprint" } | { kind: "filter"; id: string; name: string; jql: string } | { kind: "jql"; jql: string };

export const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const SPRINT_JQL = "sprint in openSprints() ORDER BY Rank ASC";

const JQL_OPERATOR = /[=~<>]|\border\s+by\b|\bin\s*\(|\bis\s+(not\s+)?(empty|null)\b/i;

/** What is typed in the search box: JQL when it reads as JQL, otherwise words to find in any issue's text. */
export function searchJql(typed: string): string {
    const text = typed.trim();
    if (JQL_OPERATOR.test(text)) return text;
    const quoted = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `text ~ "${quoted}" ORDER BY updated DESC`;
}

export function jqlOf(list: JiraList): string {
    switch (list.kind) {
        case "mine":
            return MINE_JQL;
        case "sprint":
            return SPRINT_JQL;
        case "jql":
            return searchJql(list.jql);
        default:
            return list.jql;
    }
}

/** Whether a commit message names the issue: as a whole word, in any case, so ABC-12 is not ABC-123. */
export function mentions(text: string, key: string): boolean {
    const escaped = key.replace(/[^A-Za-z0-9-]/g, "");
    return escaped.length > 0 && new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, "i").test(text);
}

export interface JiraView {
    list: JiraList;
    /** The issue open beside the list. */
    issue: string | null;
    /** The site shown; empty for the default one. */
    site: string;
}

const FIRST_VIEW: JiraView = { list: { kind: "mine" }, issue: null, site: "" };

const useViews = create<{ views: Record<string, JiraView> }>(() => ({ views: {} }));

onPaneClosed((paneId) =>
    useViews.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    }),
);

export const useJiraView = (paneId: string): JiraView => useViews((state) => state.views[paneId] ?? FIRST_VIEW);

export function updateJiraView(paneId: string, change: Partial<JiraView>): void {
    useViews.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FIRST_VIEW), ...change } } }));
}

export const openJira = (): string | null => openSurface(JIRA_ISSUES);

/** Shows an issue in the Jira pane, opening the pane if none is. */
export function openJiraIssue(key: string): void {
    const paneId = activeSurfacePane(JIRA_ISSUES) ?? openSurface(JIRA_ISSUES);
    if (paneId) updateJiraView(paneId, { issue: key });
}
