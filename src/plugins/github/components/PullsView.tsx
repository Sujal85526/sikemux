import { memo, useMemo, useState } from "react";
import { confirmDialog, notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, EmptyState, IconChevron, IconPullRequest, SkeletonRows, VirtualLogList } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type MergeMethod, type Pull, type RepoRef } from "../api";
import { githubPullFilesR, githubPullR, githubPullReviewsR, githubPullsR } from "../resources";
import { formatAgo, type Outcome } from "../runStatus";
import { needsPull } from "../compose";
import { compose, openRunFrom, setListState, showItem } from "../state";
import { CommentThread } from "./CommentThread";
import { OutcomeIcon } from "./ActionsIcon";
import { Branch, Comments, Labels, PageHead, StateMark, stateLabel, stateOf } from "./Bits";
import { useBusy, useNow } from "./hooks";
import { NewPullForm } from "./NewPullForm";
import { PullChecks } from "./PullChecks";
import { Prose } from "./Pictures";

const LIST_STATES = ["open", "closed", "all"];

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
            <span className="gha-item-head">
                <span className="gha-item-title">{pull.title}</span>
                <Labels labels={pull.labels} />
            </span>
            <Comments count={pull.comments ?? 0} />
            <span className="gha-item-sub">
                <span className="gha-item-number">#{pull.number}</span>
                {pull.author && <span>{pull.author}</span>}
                {pull.head && <Branch name={pull.head} />}
            </span>
            <span className="gha-item-when">{formatAgo(pull.updatedAt, now)}</span>
        </button>
    );
}

function kindOf(line: string): "add" | "del" | "ctx" {
    return line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
}

/** Rendered a screenful at a time, since a large diff runs to tens of thousands of lines. */
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

const MERGE_METHODS: { value: MergeMethod; label: string }[] = [
    { value: "squash", label: "Squash" },
    { value: "merge", label: "Merge commit" },
    { value: "rebase", label: "Rebase" },
];

function mergeability(mergeState: string | null, base: string): { outcome: Outcome; title: string; detail: string | null } {
    switch (mergeState) {
        case "dirty":
            return { outcome: "failure", title: `Conflicts with ${base}`, detail: "Resolve the conflicts before merging." };
        case "blocked":
            return { outcome: "blocked", title: "Merging is blocked", detail: "GitHub is waiting on the required reviews and checks." };
        case "behind":
            return { outcome: "blocked", title: `Behind ${base}`, detail: "Bring the branch up to date before merging." };
        case "clean":
        case "unstable":
        case "has_hooks":
            return { outcome: "success", title: "Ready to merge", detail: null };
        default:
            return { outcome: "queued", title: "Checking whether it can merge", detail: null };
    }
}

function MergePart({ outcome, title, detail }: { outcome: Outcome; title: string; detail?: string | null }) {
    return (
        <div className="gha-merge-part">
            <div className="gha-merge-row">
                <OutcomeIcon outcome={outcome} size={12} />
                <span className="gha-merge-title">{title}</span>
                {detail && <span className="gha-merge-detail">{detail}</span>}
            </div>
        </div>
    );
}

function MergeBox({
    repo,
    pull,
    verdict,
    reviewed,
    active,
    onOpenRun,
}: {
    repo: RepoRef;
    pull: Pull;
    verdict: string | null;
    reviewed: boolean;
    active: boolean;
    onOpenRun: (runId: number) => void;
}) {
    const [method, setMethod] = useState<MergeMethod>("squash");
    const [busy, runBusy] = useBusy();
    const base = pull.base ?? "the base branch";

    const merge = async () => {
        const sure = await confirmDialog({
            title: `Merge #${pull.number} into ${base}?`,
            body: pull.title,
            confirmLabel: "Merge",
        });
        if (!sure) return;
        try {
            await actionsApi.mergePull(repo, pull.number, method, pull.headSha ?? "");
            notify("success", `Merged #${pull.number}`);
            invalidate((kind) => kind.startsWith("gha.pull"));
        } catch (error) {
            reportError(`Could not merge #${pull.number}`)(error);
        }
    };

    const open = pull.state === "open";
    const setState = async () => {
        if (open) {
            const sure = await confirmDialog({
                title: `Close #${pull.number} without merging?`,
                body: pull.title,
                confirmLabel: "Close pull request",
                destructive: true,
            });
            if (!sure) return;
        }
        try {
            await actionsApi.setPullState(repo, pull.number, open ? "closed" : "open");
            notify("success", open ? `Closed #${pull.number}` : `Reopened #${pull.number}`);
            invalidate((kind) => kind.startsWith("gha.pull"));
        } catch (error) {
            reportError(open ? "Could not close it" : "Could not reopen it")(error);
        }
    };

    if (pull.state === "merged") {
        return (
            <div className="gha-merge-box" data-state="merged">
                <div className="gha-merge-part">
                    <div className="gha-merge-row">
                        <StateMark kind="pull" state="merged" />
                        <span className="gha-merge-title">Merged into {base}</span>
                    </div>
                </div>
            </div>
        );
    }
    if (!open) {
        return (
            <div className="gha-merge-box">
                <div className="gha-merge-part">
                    <div className="gha-merge-row">
                        <StateMark kind="pull" state="closed" />
                        <span className="gha-merge-title">Closed without merging</span>
                        <span className="gha-page-spacer" />
                        <button type="button" className="gha-btn" disabled={busy} onClick={() => runBusy(setState)}>
                            Reopen
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const verdictPart =
        verdict === "Approved"
            ? { outcome: "success" as const, title: "Approved" }
            : verdict === "Changes requested"
              ? { outcome: "failure" as const, title: "Changes requested" }
              : { outcome: "queued" as const, title: reviewed ? "No approving review yet" : "No reviews yet" };
    const merging = mergeability(pull.mergeState, base);
    return (
        <div className="gha-merge-box">
            <MergePart outcome={verdictPart.outcome} title={verdictPart.title} />
            {pull.headSha && <PullChecks repo={repo} sha={pull.headSha} active={active} onOpenRun={onOpenRun} />}
            {pull.draft ? (
                <MergePart outcome="queued" title="This is a draft" detail="Mark it ready for review on GitHub before merging." />
            ) : (
                <MergePart outcome={merging.outcome} title={merging.title} detail={merging.detail} />
            )}
            <div className="gha-merge-actions">
                {!pull.draft && (
                    <>
                        <Dropdown value={method} options={MERGE_METHODS} onChange={(value) => setMethod(value as MergeMethod)} title="How to merge" />
                        <button
                            type="button"
                            className="gha-btn primary"
                            disabled={busy || pull.mergeState === "dirty"}
                            onClick={() => runBusy(merge)}>
                            Merge pull request
                        </button>
                    </>
                )}
                <span className="gha-page-spacer" />
                <button type="button" className="gha-btn danger" disabled={busy} onClick={() => runBusy(setState)}>
                    Close pull request
                </button>
            </div>
        </div>
    );
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
    const changed = files.data ?? [];
    const merged = found.state === "merged";

    return (
        <div className="gha-detail">
            <PageHead
                mark={<StateMark kind="pull" state={found.state} draft={found.draft} size={14} />}
                title={found.title}
                number={found.number}
                url={found.url}
                backLabel="Back to pull requests"
                onBack={onBack}>
                <span className="gha-state-word" data-kind="pull" data-state={stateOf(found.state, found.draft)}>
                    {stateLabel("pull", found.state, found.draft)}
                </span>
                {found.head && found.base ? (
                    <span className="gha-page-merge">
                        {found.author ?? "Someone"} {merged ? "merged" : found.state === "open" ? "wants to merge" : "wanted to merge"}{" "}
                        <Branch name={found.head} /> into <Branch name={found.base} />
                    </span>
                ) : (
                    found.author && <span>{found.author}</span>
                )}
                {found.additions !== null && (
                    <span className="gha-diffstat">
                        <span className="gha-add">+{found.additions}</span> <span className="gha-del">−{found.deletions ?? 0}</span>
                    </span>
                )}
                <Labels labels={found.labels} />
            </PageHead>

            {found.body.trim() && <Prose>{found.body}</Prose>}

            <MergeBox repo={repo} pull={found} verdict={verdict} reviewed={(reviews.data ?? []).length > 0} active={active} onOpenRun={onOpenRun} />

            <section className="gha-files">
                <div className="gha-section-label">
                    {changed.length} file{changed.length === 1 ? "" : "s"} changed
                </div>
                {changed.map((file) => (
                    <details className="gha-file" key={file.path}>
                        <summary className="gha-file-head">
                            <span className="gha-chevron">
                                <IconChevron size={11} />
                            </span>
                            <span className="gha-file-path">{file.path}</span>
                            <span className="gha-diffstat">
                                <span className="gha-add">+{file.additions}</span> <span className="gha-del">−{file.deletions}</span>
                            </span>
                        </summary>
                        {file.patch ? <Diff patch={file.patch} /> : <div className="gha-side-empty">GitHub did not send a diff for this file.</div>}
                    </details>
                ))}
            </section>

            <CommentThread
                repo={repo}
                number={found.number}
                active={active}
                now={now}
                reviews={reviews.data ?? []}
                review={found.state === "open" ? { mine: !!login && found.author === login } : null}
            />
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
                <div className="gha-callout">
                    <span>
                        <span className="gha-tag">{projectBranch}</span> has no pull request yet.
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
