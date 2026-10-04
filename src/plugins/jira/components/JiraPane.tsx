import { useState } from "react";
import { gitOverviewR, notify, openUrl, reportError, swallow, useActiveProjectCwd } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, EmptyState, Markdown, SkeletonRows } from "../../../plugin-api/ui";
import { failureMessage, jiraApi, refreshJira, type JiraIssue, type JiraIssueSummary, type JiraPerson } from "../api";
import { jiraFiltersR, jiraIssueR, jiraSearchR, jiraStatusR } from "../resources";
import { jqlOf, mentions, updateJiraView, useJiraView, type JiraList } from "../state";
import { JiraSignIn } from "./JiraSignIn";
import { StatusChip } from "./StatusChip";
import "../jira.css";

const sameList = (a: JiraList, b: JiraList) => a.kind === b.kind && (a.kind !== "filter" || (b.kind === "filter" && a.id === b.id));

export function JiraPane({ paneId, active }: { paneId: string; active: boolean }) {
    const status = useResourceEnabled(active, jiraStatusR);
    if (status.data === undefined && status.status !== "error") return <SkeletonRows rows={5} label="Connecting to Jira" />;
    if (!status.data?.configured || status.data.authFailed) return <JiraSignIn status={status.data} onSignedIn={refreshJira} />;
    return <JiraWorkspace paneId={paneId} active={active} sites={status.data.sites.map((site) => site.host)} />;
}

function JiraWorkspace({ paneId, active, sites }: { paneId: string; active: boolean; sites: string[] }) {
    const view = useJiraView(paneId);
    const [jql, setJql] = useState(view.list.kind === "jql" ? view.list.jql : "");
    const filters = useResourceEnabled(active, jiraFiltersR, view.site);
    const show = (list: JiraList) => updateJiraView(paneId, { list });
    const site = view.site || sites[0] || "";

    return (
        <div className="jira-pane">
            <nav className="jira-sidebar" aria-label="Jira lists">
                {sites.length > 1 && (
                    <Dropdown
                        label="Site"
                        value={site}
                        options={sites.map((host) => ({ value: host, label: host }))}
                        onChange={(host) => updateJiraView(paneId, { site: host, issue: null })}
                    />
                )}
                <div className="jira-lists">
                    {(
                        [
                            [{ kind: "mine" }, "Assigned to me"],
                            [{ kind: "sprint" }, "Current sprint"],
                        ] as const
                    ).map(([list, label]) => (
                        <button
                            key={label}
                            type="button"
                            className={`jira-list${sameList(view.list, list) ? " active" : ""}`}
                            onClick={() => show(list)}>
                            {label}
                        </button>
                    ))}
                </div>
                {(filters.data?.length ?? 0) > 0 && (
                    <div className="jira-lists">
                        <div className="jira-heading">Starred filters</div>
                        {filters.data?.map((filter) => {
                            const list: JiraList = { kind: "filter", ...filter };
                            return (
                                <button
                                    key={filter.id}
                                    type="button"
                                    className={`jira-list${sameList(view.list, list) ? " active" : ""}`}
                                    title={filter.jql}
                                    onClick={() => show(list)}>
                                    {filter.name}
                                </button>
                            );
                        })}
                    </div>
                )}
                <label className="jira-jql">
                    <span className="jira-heading">Search</span>
                    <input
                        value={jql}
                        onChange={(event) => setJql(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && jql.trim()) show({ kind: "jql", jql: jql.trim() });
                        }}
                        placeholder="Words, or JQL like project = ABC"
                        spellCheck={false}
                    />
                </label>
                <button
                    type="button"
                    className="jira-signout"
                    onClick={() => void jiraApi.signOut(site).then(refreshJira).catch(reportError("sign out of Jira"))}>
                    Sign out of {site}
                </button>
            </nav>
            <IssueList
                active={active}
                jql={jqlOf(view.list)}
                site={view.site}
                selected={view.issue}
                onSelect={(key) => updateJiraView(paneId, { issue: key })}
            />
            {view.issue ? (
                <IssueDetail active={active} issueKey={view.issue} site={view.site} />
            ) : (
                <div className="jira-detail">
                    <EmptyState message="Pick an issue to read it, comment, move it along or assign it." />
                </div>
            )}
        </div>
    );
}

function IssueList({
    active,
    jql,
    site,
    selected,
    onSelect,
}: {
    active: boolean;
    jql: string;
    site: string;
    selected: string | null;
    onSelect: (key: string) => void;
}) {
    const found = useResourceEnabled(active, jiraSearchR, jql, site);
    if (found.status === "error")
        return (
            <div className="jira-list-pane">
                <EmptyState message={found.error ?? "Jira could not run that search."} tone="error" />
            </div>
        );
    if (!found.data)
        return (
            <div className="jira-list-pane">
                <SkeletonRows rows={8} label="Loading issues" />
            </div>
        );
    if (found.data.issues.length === 0)
        return (
            <div className="jira-list-pane">
                <EmptyState message="No issues here." />
            </div>
        );
    return (
        <div className="jira-list-pane" role="list">
            {found.data.issues.map((issue) => (
                <IssueRow key={issue.key} issue={issue} selected={issue.key === selected} onSelect={() => onSelect(issue.key)} />
            ))}
        </div>
    );
}

function IssueRow({ issue, selected, onSelect }: { issue: JiraIssueSummary; selected: boolean; onSelect: () => void }) {
    return (
        <button type="button" role="listitem" className={`jira-row${selected ? " active" : ""}`} onClick={onSelect}>
            <span className="jira-row-top">
                <span className="jira-key">{issue.key}</span>
                {issue.priority && <span className="jira-meta">{issue.priority}</span>}
                <StatusChip status={issue.status} category={issue.statusCategory} />
            </span>
            <span className="jira-row-summary">{issue.summary}</span>
            <span className="jira-meta">
                {issue.assignee?.name ?? "Unassigned"}
                {issue.sprint && ` · ${issue.sprint}`}
            </span>
        </button>
    );
}

function IssueDetail({ active, issueKey, site }: { active: boolean; issueKey: string; site: string }) {
    const found = useResourceEnabled(active, jiraIssueR, issueKey, site);
    if (found.status === "error")
        return (
            <div className="jira-detail">
                <EmptyState message={found.error ?? `Jira could not open ${issueKey}.`} tone="error" />
            </div>
        );
    if (!found.data)
        return (
            <div className="jira-detail">
                <SkeletonRows rows={6} label={`Loading ${issueKey}`} />
            </div>
        );
    return <IssueBody issue={found.data} site={site} refresh={() => void found.refresh()} />;
}

function IssueBody({ issue, site, refresh }: { issue: JiraIssue; site: string; refresh: () => void }) {
    const [comment, setComment] = useState("");
    const [busy, setBusy] = useState(false);
    const [assigning, setAssigning] = useState(false);
    const [people, setPeople] = useState<JiraPerson[]>([]);
    const changed = () => {
        refresh();
        refreshJira();
    };
    const run = async (label: string, work: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await work();
            changed();
        } catch (error) {
            notify("error", `${label}: ${failureMessage(error)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <article className="jira-detail" aria-label={`${issue.key} ${issue.summary}`}>
            <header className="jira-detail-head">
                <button
                    type="button"
                    className="jira-key link"
                    title="Open in Jira"
                    onClick={() => void openUrl(issue.url).catch(swallow("open Jira"))}>
                    {issue.key}
                </button>
                <h2>{issue.summary}</h2>
            </header>
            <div className="jira-facts">
                <Dropdown
                    label="Status"
                    value=""
                    title="Move this issue along its workflow"
                    options={issue.transitions.map((transition) => ({ value: transition.id, label: transition.name, detail: `→ ${transition.to}` }))}
                    onChange={(id) => void run("Move issue", () => jiraApi.transition(issue.key, id, site || undefined))}
                    disabled={busy || issue.transitions.length === 0}
                    trailing={<StatusChip status={issue.status} category={issue.statusCategory} />}
                />
                <span className="jira-fact">
                    <span className="jira-heading">Assignee</span>
                    <span>{issue.assignee?.name ?? "Unassigned"}</span>
                    <button
                        type="button"
                        className="jira-chip"
                        disabled={busy}
                        onClick={() => void run("Assign", () => jiraApi.assign(issue.key, { me: true }, site || undefined))}>
                        Assign to me
                    </button>
                    <button
                        type="button"
                        className="jira-chip"
                        disabled={busy || !issue.assignee}
                        onClick={() => void run("Unassign", () => jiraApi.assign(issue.key, { accountId: null }, site || undefined))}>
                        Unassign
                    </button>
                    <button type="button" className="jira-chip" disabled={busy} onClick={() => setAssigning((open) => !open)}>
                        Assign…
                    </button>
                </span>
                {assigning && (
                    <div className="jira-assign">
                        <input
                            autoFocus
                            placeholder="Find a person"
                            onChange={(event) =>
                                void jiraApi
                                    .assignable(issue.key, event.target.value, site || undefined)
                                    .then(setPeople)
                                    .catch(swallow("find people"))
                            }
                        />
                        {people.map((person) => (
                            <button
                                key={person.accountId}
                                type="button"
                                className="jira-chip"
                                onClick={() => {
                                    setAssigning(false);
                                    void run("Assign", () => jiraApi.assign(issue.key, { accountId: person.accountId }, site || undefined));
                                }}>
                                {person.name}
                            </button>
                        ))}
                    </div>
                )}
                <span className="jira-meta">
                    {[
                        issue.issueType,
                        issue.priority,
                        issue.sprint,
                        issue.labels.join(", ") || null,
                        issue.reporter && `reported by ${issue.reporter.name}`,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
            </div>
            <section className="jira-description">
                {issue.description ? <Markdown>{issue.description}</Markdown> : <p className="jira-meta">No description.</p>}
            </section>
            <ProjectCommits issueKey={issue.key} />
            <section className="jira-comments" aria-label="Comments">
                <div className="jira-heading">
                    Comments{issue.commentCount > issue.comments.length ? ` (latest ${issue.comments.length} of ${issue.commentCount})` : ""}
                </div>
                {issue.comments.map((entry) => (
                    <div key={entry.id} className="jira-comment">
                        <div className="jira-meta">
                            {entry.author} · {new Date(entry.created).toLocaleString()}
                        </div>
                        <Markdown>{entry.body}</Markdown>
                    </div>
                ))}
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment in markdown" rows={3} />
                <button
                    type="button"
                    className="jira-chip primary"
                    disabled={busy || !comment.trim()}
                    onClick={() =>
                        void run("Comment", async () => {
                            await jiraApi.comment(issue.key, comment, site || undefined);
                            setComment("");
                        })
                    }>
                    Comment
                </button>
            </section>
        </article>
    );
}

/** The open project's recent commits that name the issue in their message. */
function ProjectCommits({ issueKey }: { issueKey: string }) {
    const cwd = useActiveProjectCwd();
    const repo = useResourceEnabled(!!cwd, gitOverviewR, cwd ?? "");
    const commits = (repo.data?.log ?? []).filter((commit) => mentions(commit.subject, issueKey));
    if (commits.length === 0) return null;
    return (
        <section className="jira-commits" aria-label="Commits in this project">
            <div className="jira-heading">Commits in this project</div>
            {commits.map((commit) => (
                <div key={commit.full_hash} className="jira-commit">
                    <span className="jira-key">{commit.hash}</span>
                    <span>{commit.subject}</span>
                    <span className="jira-meta">{commit.author}</span>
                </div>
            ))}
        </section>
    );
}
