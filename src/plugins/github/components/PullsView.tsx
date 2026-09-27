import { confirmDialog, notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconClose, IconPullRequest, Markdown, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type MergeMethod, type Pull, type RepoRef } from "../api";
import { githubPullFilesR, githubPullR, githubPullReviewsR, githubPullsR } from "../resources";
import { formatAgo } from "../runStatus";
import { setListState, showItem } from "../state";
import { CommentThread } from "./CommentThread";
import { Labels, StateChip } from "./Bits";
import { useNow } from "./hooks";

const LIST_STATES = ["open", "closed", "all"];

/** What a pull request's review state adds up to, in one word. */
export function reviewVerdict(reviews: readonly { author: string | null; state: string }[]): string | null {
    // Only a person's latest review counts, which is how GitHub scores it too.
    const latest = new Map<string, string>();
    for (const review of reviews) {
        if (review.state === "COMMENTED" || review.state === "DISMISSED") continue;
        latest.set(review.author ?? "", review.state);
    }
    const states = [...latest.values()];
    if (states.includes("CHANGES_REQUESTED")) return "Changes requested";
    if (states.includes("APPROVED")) return "Approved";
    return null;
}

function PullRow({ pull, now, onOpen }: { pull: Pull; now: number; onOpen: () => void }) {
    return (
        <button type="button" className="gha-item-row" onClick={onOpen}>
            <StateChip kind="pull" state={pull.state} draft={pull.draft} />
            <span className="gha-item-main">
                <span className="gha-item-title">{pull.title}</span>
                <span className="gha-item-sub">
                    <span className="gha-mono">#{pull.number}</span>
                    {pull.author && <span>{pull.author}</span>}
                    {pull.head && <span className="gha-branch">{pull.head}</span>}
                    <span>{formatAgo(pull.updatedAt, now)}</span>
                    <Labels labels={pull.labels} />
                </span>
            </span>
            {pull.comments > 0 && <span className="gha-dim">{pull.comments} comments</span>}
        </button>
    );
}

function Diff({ patch }: { patch: string }) {
    return (
        <pre className="gha-patch gha-mono">
            {patch.split("\n").map((line, index) => (
                <span key={index} className="gha-patch-line" data-kind={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"}>
                    {line || " "}
                </span>
            ))}
        </pre>
    );
}

function PullDetail({ repo, number, active, onBack }: { repo: RepoRef; number: number; active: boolean; onBack: () => void }) {
    const pull = useResourceEnabled(active, githubPullR, repo, number);
    const files = useResourceEnabled(active, githubPullFilesR, repo, number);
    const reviews = useResourceEnabled(active, githubPullReviewsR, repo, number);
    const now = useNow(false);

    if (pull.status === "loading" && !pull.data) return <SkeletonRows rows={8} label="Loading pull request" />;
    if (!pull.data) {
        return <EmptyState title="Could not read it" message={failureMessage(pull.error)} tone="error" action={{ label: "Back", onClick: onBack }} />;
    }
    const found = pull.data;
    const verdict = reviewVerdict(reviews.data ?? []);

    const merge = async (method: MergeMethod) => {
        const sure = await confirmDialog({
            title: `${method === "merge" ? "Merge" : method === "squash" ? "Squash and merge" : "Rebase and merge"} #${found.number}?`,
            body: found.title,
            confirmLabel: "Merge",
        });
        if (!sure) return;
        try {
            await actionsApi.mergePull(repo, found.number, method);
            notify("success", `Merged #${found.number}`);
            invalidate((kind) => kind.startsWith("gha.pull"));
        } catch (error) {
            reportError(`Could not merge #${found.number}`)(error);
        }
    };

    return (
        <div className="gha-detail">
            <button type="button" className="gha-back" onClick={onBack}>
                <IconClose size={11} /> Back to pull requests
            </button>
            <div className="gha-detail-head">
                <div className="gha-detail-title-row">
                    <StateChip kind="pull" state={found.state} draft={found.draft} />
                    <h2 className="gha-detail-title">{found.title}</h2>
                    <span className="gha-mono gha-dim">#{found.number}</span>
                </div>
                <div className="gha-detail-sub">
                    {found.author && <span>{found.author}</span>}
                    {found.head && found.base && (
                        <span className="gha-dim">
                            <span className="gha-branch">{found.head}</span> into <span className="gha-branch">{found.base}</span>
                        </span>
                    )}
                    {found.additions !== null && (
                        <span className="gha-mono">
                            <span className="gha-add">+{found.additions}</span> <span className="gha-del">−{found.deletions ?? 0}</span>
                        </span>
                    )}
                    {verdict && (
                        <span className="gha-badge" data-verdict={verdict === "Approved" ? "ok" : "block"}>
                            {verdict}
                        </span>
                    )}
                    <Labels labels={found.labels} />
                </div>
                <div className="gha-detail-actions">
                    {found.state === "open" && !found.draft && (
                        <>
                            <button type="button" className="gha-btn primary" onClick={() => void merge("squash")}>
                                Squash and merge
                            </button>
                            <button type="button" className="gha-btn" onClick={() => void merge("merge")}>
                                Merge
                            </button>
                        </>
                    )}
                    <button type="button" className="gha-link" onClick={() => void openUrl(found.url).catch(swallow("open GitHub"))}>
                        On GitHub
                    </button>
                </div>
            </div>

            {found.body.trim() && <Markdown className="gha-prose">{found.body}</Markdown>}

            <div className="gha-section-label">
                {files.data?.length ?? 0} file{(files.data?.length ?? 0) === 1 ? "" : "s"} changed
            </div>
            {(files.data ?? []).map((file) => (
                <details className="gha-file" key={file.path}>
                    <summary className="gha-file-head">
                        <span className="gha-mono gha-file-path">{file.path}</span>
                        <span className="gha-mono">
                            <span className="gha-add">+{file.additions}</span> <span className="gha-del">−{file.deletions}</span>
                        </span>
                    </summary>
                    {file.patch ? <Diff patch={file.patch} /> : <div className="gha-side-empty">GitHub did not send a diff for this file.</div>}
                </details>
            ))}

            <CommentThread repo={repo} number={found.number} active={active} now={now} />
        </div>
    );
}

interface Props {
    paneId: string;
    repo: RepoRef;
    listState: string;
    item: number | null;
    active: boolean;
}

export function PullsView({ paneId, repo, listState, item, active }: Props) {
    const pulls = useResourceEnabled(active && item === null, githubPullsR, repo, listState);
    const now = useNow(false);

    if (item !== null) return <PullDetail repo={repo} number={item} active={active} onBack={() => showItem(paneId, null)} />;
    if (pulls.status === "loading" && !pulls.data) return <SkeletonRows rows={8} label="Loading pull requests" />;
    if (pulls.error) {
        return (
            <EmptyState
                title="Could not read pull requests"
                message={failureMessage(pulls.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void pulls.refresh() }}
            />
        );
    }
    const rows = pulls.data ?? [];

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
                <span className="gha-dim">
                    {rows.length} pull request{rows.length === 1 ? "" : "s"}
                </span>
            </div>
            {rows.length === 0 ? (
                <EmptyState icon={<IconPullRequest size={20} />} message={`No ${listState === "all" ? "" : listState} pull requests.`} />
            ) : (
                rows.map((pull) => <PullRow key={pull.number} pull={pull} now={now} onOpen={() => showItem(paneId, pull.number)} />)
            )}
        </div>
    );
}
