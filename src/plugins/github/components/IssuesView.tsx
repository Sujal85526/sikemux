import { notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconClose, IconInfo, Markdown, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type Issue, type RepoRef } from "../api";
import { githubIssueR, githubIssuesR } from "../resources";
import { formatAgo } from "../runStatus";
import { compose, setListState, showItem, updateView } from "../state";
import { Labels, StateMark } from "./Bits";
import { CommentThread } from "./CommentThread";
import { useBusy, useNow } from "./hooks";
import { NewIssueForm } from "./NewIssueForm";

const LIST_STATES = ["open", "closed", "all"];

function IssueRow({ issue, now, onOpen }: { issue: Issue; now: number; onOpen: () => void }) {
    return (
        <button type="button" className="gha-item-row" onClick={onOpen}>
            <StateMark kind="issue" state={issue.state} />
            <span className="gha-item-main">
                <span className="gha-item-title">{issue.title}</span>
                <span className="gha-item-sub">
                    <span className="gha-mono">#{issue.number}</span>
                    {issue.author && <span>{issue.author}</span>}
                    <span>{formatAgo(issue.updatedAt, now)}</span>
                    {issue.assignees.length > 0 && <span className="gha-dim">→ {issue.assignees.join(", ")}</span>}
                    <Labels labels={issue.labels} />
                </span>
            </span>
            {issue.comments > 0 && <span className="gha-dim">{issue.comments} comments</span>}
        </button>
    );
}

function IssueDetail({ repo, number, active, onBack }: { repo: RepoRef; number: number; active: boolean; onBack: () => void }) {
    const issue = useResourceEnabled(active, githubIssueR, repo, number);
    const now = useNow(false);
    const [busy, runBusy] = useBusy();
    if (issue.status === "loading" && !issue.data) return <SkeletonRows rows={6} label="Loading issue" />;
    if (!issue.data) {
        return (
            <EmptyState title="Could not read it" message={failureMessage(issue.error)} tone="error" action={{ label: "Back", onClick: onBack }} />
        );
    }
    const found = issue.data;
    const closing = found.state === "open";

    const setState = () =>
        runBusy(() =>
            actionsApi
                .setIssueState(repo, found.number, closing ? "closed" : "open")
                .then(() => {
                    notify("success", closing ? `Closed #${found.number}` : `Reopened #${found.number}`);
                    invalidate((kind) => kind === "gha.issue" || kind === "gha.issues");
                })
                .catch(reportError(closing ? "Could not close it" : "Could not reopen it")),
        );

    return (
        <div className="gha-detail">
            <button type="button" className="gha-back" onClick={onBack}>
                <IconClose size={11} /> Back to issues
            </button>
            <div className="gha-detail-head">
                <div className="gha-detail-title-row">
                    <StateMark kind="issue" state={found.state} />
                    <h2 className="gha-detail-title">{found.title}</h2>
                    <span className="gha-mono gha-dim">#{found.number}</span>
                </div>
                <div className="gha-detail-sub">
                    {found.author && <span>{found.author}</span>}
                    <span className="gha-dim">opened {formatAgo(found.createdAt, now)}</span>
                    <Labels labels={found.labels} />
                </div>
                <div className="gha-detail-actions">
                    <button type="button" className="gha-btn" disabled={busy} onClick={setState}>
                        {closing ? "Close issue" : "Reopen issue"}
                    </button>
                    <button type="button" className="gha-link" onClick={() => void openUrl(found.url).catch(swallow("open GitHub"))}>
                        On GitHub
                    </button>
                </div>
            </div>
            {found.body.trim() && <Markdown className="gha-prose">{found.body}</Markdown>}
            <CommentThread repo={repo} number={found.number} active={active} now={now} />
        </div>
    );
}

interface Props {
    paneId: string;
    repo: RepoRef;
    listState: string;
    item: number | null;
    composing: boolean;
    page: number;
    active: boolean;
}

export function IssuesView({ paneId, repo, listState, item, composing, page, active }: Props) {
    const issues = useResourceEnabled(active && item === null && !composing, githubIssuesR, repo, listState, page);
    const now = useNow(false);

    if (composing) return <NewIssueForm repo={repo} onCreated={(number) => showItem(paneId, number)} onCancel={() => compose(paneId, null)} />;
    if (item !== null) return <IssueDetail repo={repo} number={item} active={active} onBack={() => showItem(paneId, null)} />;
    if (issues.status === "loading" && !issues.data) return <SkeletonRows rows={8} label="Loading issues" />;
    if (issues.error) {
        return (
            <EmptyState
                title="Could not read issues"
                message={failureMessage(issues.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void issues.refresh() }}
            />
        );
    }
    const rows = issues.data?.issues ?? [];
    const total = issues.data?.total ?? rows.length;
    const nextPage = issues.data?.nextPage ?? null;

    return (
        <div className="gha-list">
            <div className="gha-list-head">
                <div className="gha-chips">
                    {LIST_STATES.map((state) => (
                        <button
                            key={state}
                            type="button"
                            className="gha-chip"
                            data-on={listState === state ? "1" : "0"}
                            onClick={() => setListState(paneId, state)}>
                            {state === "all" ? "All" : state === "open" ? "Open" : "Closed"}
                        </button>
                    ))}
                </div>
                <span className="gha-dim gha-list-count">
                    {total} issue{total === 1 ? "" : "s"}
                    <button type="button" className="gha-btn" onClick={() => compose(paneId, "issue")}>
                        New issue
                    </button>
                </span>
            </div>
            {rows.length === 0 ? (
                <EmptyState icon={<IconInfo size={20} />} message={`No ${listState === "all" ? "" : listState} issues.`} />
            ) : (
                rows.map((issue) => <IssueRow key={issue.number} issue={issue} now={now} onOpen={() => showItem(paneId, issue.number)} />)
            )}
            {(page > 1 || nextPage) && (
                <div className="gha-pager">
                    <button type="button" className="gha-btn" disabled={page <= 1} onClick={() => updateView(paneId, { page: page - 1 })}>
                        Newer
                    </button>
                    <span className="gha-dim">Page {page}</span>
                    <button type="button" className="gha-btn" disabled={!nextPage} onClick={() => updateView(paneId, { page: page + 1 })}>
                        Older
                    </button>
                </div>
            )}
        </div>
    );
}
