import { memo, useMemo } from "react";
import { confirmDialog, notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconClose, IconPullRequest, Markdown, SkeletonRows, VirtualLogList } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type MergeMethod, type Pull, type RepoRef } from "../api";
import { githubPullFilesR, githubPullR, githubPullReviewsR, githubPullsR } from "../resources";
import { formatAgo } from "../runStatus";
import { needsPull } from "../compose";
import { compose, openRunFrom, setListState, showItem } from "../state";
import { CommentThread } from "./CommentThread";
import { Labels, StateMark } from "./Bits";
import { useNow } from "./hooks";
import { NewPullForm } from "./NewPullForm";
import { PullChecks } from "./PullChecks";
import { ReviewBox } from "./ReviewBox";

const LIST_STATES = ["open", "closed", "all"];

const REVIEW_WORD: Record<string, string> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "asked for changes",
    COMMENTED: "commented",
    DISMISSED: "was dismissed",
};

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
            <StateMark kind="pull" state={pull.state} draft={pull.draft} />
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
            {!!pull.comments && (
                <span className="gha-dim">
                    {pull.comments} comment{pull.comments === 1 ? "" : "s"}
                </span>
            )}
        </button>
    );
}

function kindOf(line: string): "add" | "del" | "ctx" {
    return line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
}

/**
 * A diff is rendered a screenful at a time. A large one runs to tens of
 * thousands of lines, and putting every one of them in the document costs far
 * more than the handful anybody looks at.
 */
const Diff = memo(function Diff({ patch }: { patch: string }) {
    const lines = useMemo(() => patch.split("\n"), [patch]);
    return (
        <VirtualLogList
            items={lines}
            className="gha-patch gha-mono"
            rowClassName={(line) => `gha-patch-line ${kindOf(line)}`}
            estimateSize={18}
            getItemKey={(_, index) => index}
            renderRow={(line) => line || " "}
        />
    );
});

interface DetailProps {
    repo: RepoRef;
    number: number;
    active: boolean;
    login: string | null;
    onBack: () => void;
    onOpenRun: (runId: number) => void;
}

function PullDetail({ repo, number, active, login, onBack, onOpenRun }: DetailProps) {
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

    const closing = found.state === "open";
    const setState = async () => {
        if (closing) {
            const sure = await confirmDialog({
                title: `Close #${found.number} without merging?`,
                body: found.title,
                confirmLabel: "Close pull request",
                destructive: true,
            });
            if (!sure) return;
        }
        try {
            await actionsApi.setPullState(repo, found.number, closing ? "closed" : "open");
            notify("success", closing ? `Closed #${found.number}` : `Reopened #${found.number}`);
            invalidate((kind) => kind.startsWith("gha.pull"));
        } catch (error) {
            reportError(closing ? "Could not close it" : "Could not reopen it")(error);
        }
    };
    const written = (reviews.data ?? []).filter((review) => review.state !== "COMMENTED" || review.body.trim());

    return (
        <div className="gha-detail">
            <button type="button" className="gha-back" onClick={onBack}>
                <IconClose size={11} /> Back to pull requests
            </button>
            <div className="gha-detail-head">
                <div className="gha-detail-title-row">
                    <StateMark kind="pull" state={found.state} draft={found.draft} />
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
                            <button type="button" className="gha-btn" onClick={() => void merge("rebase")}>
                                Rebase and merge
                            </button>
                        </>
                    )}
                    {found.state !== "merged" && (
                        <button type="button" className={closing ? "gha-btn danger" : "gha-btn"} onClick={() => void setState()}>
                            {closing ? "Close" : "Reopen"}
                        </button>
                    )}
                    <button type="button" className="gha-link" onClick={() => void openUrl(found.url).catch(swallow("open GitHub"))}>
                        On GitHub
                    </button>
                </div>
            </div>

            {found.mergeState === "dirty" && found.state === "open" && (
                <div className="gha-warn-note">This branch conflicts with {found.base ?? "its base"}. Resolve the conflicts before merging.</div>
            )}
            {found.mergeState === "blocked" && found.state === "open" && (
                <div className="gha-warn-note">GitHub is holding this back until the required reviews and checks pass.</div>
            )}

            {found.body.trim() && <Markdown className="gha-prose">{found.body}</Markdown>}

            {found.headSha && <PullChecks repo={repo} sha={found.headSha} active={active} onOpenRun={onOpenRun} />}

            {written.length > 0 && (
                <div className="gha-reviews">
                    <div className="gha-section-label">Reviews</div>
                    {written.map((review, index) => (
                        <div className="gha-comment" key={`${review.author ?? ""}-${review.submittedAt ?? index}`}>
                            <div className="gha-comment-head">
                                <span className="gha-comment-author">{review.author ?? "someone"}</span>
                                <span className="gha-review-state" data-state={review.state}>
                                    {REVIEW_WORD[review.state] ?? review.state.toLowerCase()}
                                </span>
                                <span className="gha-dim">{formatAgo(review.submittedAt, now)}</span>
                            </div>
                            {review.body.trim() && <Markdown className="gha-prose">{review.body}</Markdown>}
                        </div>
                    ))}
                </div>
            )}

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
            {found.state === "open" && <ReviewBox repo={repo} number={found.number} mine={!!login && found.author === login} />}
        </div>
    );
}

interface Props {
    paneId: string;
    repo: RepoRef;
    listState: string;
    item: number | null;
    composing: boolean;
    projectBranch: string | null;
    login: string | null;
    active: boolean;
}

export function PullsView({ paneId, repo, listState, item, composing, projectBranch, login, active }: Props) {
    const listing = item === null && !composing;
    const pulls = useResourceEnabled(active && listing, githubPullsR, repo, listState);
    const open = useResourceEnabled(active && listing && !!projectBranch, githubPullsR, repo, "open");
    const now = useNow(false);

    if (composing) {
        return (
            <NewPullForm
                repo={repo}
                head={projectBranch}
                active={active}
                onCreated={(number) => showItem(paneId, number)}
                onCancel={() => compose(paneId, null)}
            />
        );
    }
    if (item !== null) {
        return (
            <PullDetail
                repo={repo}
                number={item}
                active={active}
                login={login}
                onBack={() => showItem(paneId, null)}
                onOpenRun={(runId) => openRunFrom(paneId, runId)}
            />
        );
    }
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
    const offer = !!open.data && needsPull(projectBranch, open.data, []);

    return (
        <div className="gha-list">
            {offer && projectBranch && (
                <div className="gha-offer">
                    <span>
                        <span className="gha-branch">{projectBranch}</span> has no pull request yet.
                    </span>
                    <button type="button" className="gha-btn primary" onClick={() => compose(paneId, "pull")}>
                        Open one
                    </button>
                </div>
            )}
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
                    {rows.length} pull request{rows.length === 1 ? "" : "s"}
                    <button type="button" className="gha-btn" onClick={() => compose(paneId, "pull")}>
                        New pull request
                    </button>
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
