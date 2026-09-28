import { memo, useMemo, useState, type ReactNode } from "react";
import { confirmDialog, copyText, notify, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import {
    Dropdown,
    EmptyState,
    IconChevron,
    IconClock,
    IconCopy,
    IconPullRequest,
    SkeletonRows,
    Tooltip,
    VirtualLogList,
} from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type MergeMethod, type Pull, type RepoRef, type Review } from "../api";
import { githubPullCommitsR, githubTimelineR, githubPullFilesR, githubPullR, githubPullReviewsR, githubPullsR } from "../resources";
import { formatAgo, type Outcome } from "../runStatus";
import { needsPull } from "../compose";
import { compose, openRunFrom, setListState, showItem } from "../state";
import { CommentThread, Face } from "./CommentThread";
import { OutcomeIcon } from "./ActionsIcon";
import { Branch, Comments, Labels, PageHead, StateMark, stateLabel, stateOf, Who } from "./Bits";
import { useBusy, useNow } from "./hooks";
import { NewPullForm } from "./NewPullForm";
import { PullChecks } from "./PullChecks";

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

type PullTab = "conversation" | "commits" | "files";

function plural(count: number, word: string): string {
    return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function latestReviews(reviews: readonly Review[]): Map<string, Review> {
    const latest = new Map<string, Review>();
    for (const review of reviews) {
        if (!review.author) continue;
        const before = latest.get(review.author);
        if (review.state === "COMMENTED" && before && before.state !== "COMMENTED") continue;
        latest.set(review.author, review);
    }
    return latest;
}

const REVIEW_OUTCOME: Record<string, Outcome> = {
    APPROVED: "success",
    CHANGES_REQUESTED: "failure",
    COMMENTED: "skipped",
    DISMISSED: "cancelled",
};

function SideSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="gha-side-part">
            <div className="gha-side-title">{title}</div>
            {children}
        </section>
    );
}

function PullSide({
    pull,
    reviews,
    participants,
}: {
    pull: Pull;
    reviews: readonly Review[];
    participants: readonly { login: string; avatarUrl: string | null }[];
}) {
    const latest = latestReviews(reviews);
    const waiting = pull.reviewers.filter((login) => !latest.has(login));
    return (
        <aside className="gha-pull-side">
            <SideSection title="Reviewers">
                {latest.size === 0 && waiting.length === 0 && <span className="gha-side-none">No reviews</span>}
                {[...latest.values()].map((review) => (
                    <div className="gha-side-person" key={review.author}>
                        <Face login={review.author} url={review.avatarUrl} />
                        <span>{review.author}</span>
                        <span className="gha-page-spacer" />
                        <OutcomeIcon outcome={REVIEW_OUTCOME[review.state] ?? "unknown"} size={12} />
                    </div>
                ))}
                {waiting.map((login) => (
                    <div className="gha-side-person" key={login}>
                        <Face login={login} url={pull.avatars[login] ?? null} />
                        <span>{login}</span>
                        <span className="gha-page-spacer" />
                        <span className="gha-side-none" title="Awaiting review">
                            <IconClock size={12} />
                        </span>
                    </div>
                ))}
            </SideSection>
            <SideSection title="Assignees">
                {pull.assignees.length === 0 ? (
                    <span className="gha-side-none">No one assigned</span>
                ) : (
                    pull.assignees.map((login) => (
                        <div className="gha-side-person" key={login}>
                            <Face login={login} url={pull.avatars[login] ?? null} />
                            <span>{login}</span>
                        </div>
                    ))
                )}
            </SideSection>
            <SideSection title="Labels">
                {pull.labels.length === 0 ? <span className="gha-side-none">None yet</span> : <Labels labels={pull.labels} />}
            </SideSection>
            <SideSection title="Milestone">
                <span className={pull.milestone ? undefined : "gha-side-none"}>{pull.milestone ?? "No milestone"}</span>
            </SideSection>
            <SideSection title={plural(participants.length, "participant")}>
                <div className="gha-side-faces">
                    {participants.map((person) => (
                        <span key={person.login} title={person.login}>
                            <Face login={person.login} url={person.avatarUrl} />
                        </span>
                    ))}
                </div>
            </SideSection>
        </aside>
    );
}

function CommitsTab({ repo, number, active, now }: { repo: RepoRef; number: number; active: boolean; now: number }) {
    const commits = useResourceEnabled(active, githubPullCommitsR, repo, number);
    if (commits.status === "loading" && !commits.data) return <SkeletonRows rows={6} label="Loading commits" />;
    if (commits.error && !commits.data) return <EmptyState title="Could not read the commits" message={failureMessage(commits.error)} tone="error" />;
    return (
        <div className="gha-commits">
            {(commits.data ?? []).map((commit) => (
                <div className="gha-commit" key={commit.sha}>
                    <Face login={commit.author} url={commit.avatarUrl} />
                    <span className="gha-commit-main">
                        <span className="gha-commit-message">{commit.message.split("\n")[0]}</span>
                        <span className="gha-commit-sub">
                            {commit.author ?? "someone"} committed {formatAgo(commit.date, now)}
                        </span>
                    </span>
                    <button
                        type="button"
                        className="gha-btn gha-commit-sha"
                        title="Copy the full commit"
                        onClick={() =>
                            void copyText(commit.sha)
                                .then(() => notify("success", `Copied ${commit.sha.slice(0, 7)}`))
                                .catch(swallow("copy the commit"))
                        }>
                        {commit.sha.slice(0, 7)}
                    </button>
                </div>
            ))}
        </div>
    );
}

function FilesTab({ repo, number, active }: { repo: RepoRef; number: number; active: boolean }) {
    const files = useResourceEnabled(active, githubPullFilesR, repo, number);
    if (files.status === "loading" && !files.data) return <SkeletonRows rows={6} label="Loading files" />;
    if (files.error && !files.data) return <EmptyState title="Could not read the files" message={failureMessage(files.error)} tone="error" />;
    return (
        <section className="gha-files">
            {(files.data ?? []).map((file) => (
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
    );
}

function PullDetail({ repo, number, active, login, onBack, onOpenRun }: DetailProps) {
    const [tab, setTab] = useState<PullTab>("conversation");
    const pull = useResourceEnabled(active, githubPullR, repo, number);
    const reviews = useResourceEnabled(active, githubPullReviewsR, repo, number);
    const timeline = useResourceEnabled(active && tab === "conversation", githubTimelineR, repo, number);
    const now = useNow(false);

    if (pull.status === "loading" && !pull.data) return <SkeletonRows rows={8} label="Loading pull request" />;
    if (!pull.data) {
        return <EmptyState title="Could not read it" message={failureMessage(pull.error)} tone="error" action={{ label: "Back", onClick: onBack }} />;
    }
    const found = pull.data;
    const reviewList = reviews.data ?? [];
    const verdict = reviewVerdict(reviewList);
    const merged = found.state === "merged";
    const actor = merged ? (found.mergedBy ?? found.author) : found.author;
    const verb = merged ? "merged" : found.state === "open" ? "wants to merge" : "wanted to merge";
    const from = found.headLabel ?? found.head;

    const people = new Map<string, string | null>();
    const meet = (who: string | null, avatarUrl: string | null) => {
        if (who && !people.get(who)) people.set(who, avatarUrl);
    };
    meet(found.author, found.avatarUrl);
    for (const review of reviewList) meet(review.author, review.avatarUrl);
    for (const item of timeline.data ?? []) if (item.kind === "commented" || item.kind === "reviewed") meet(item.actor, item.avatarUrl);
    const participants = [...people].map(([who, avatarUrl]) => ({ login: who, avatarUrl }));

    const tabs: { id: PullTab; label: string; count: number | null }[] = [
        { id: "conversation", label: "Conversation", count: null },
        { id: "commits", label: "Commits", count: found.commits },
        { id: "files", label: "Files changed", count: found.changedFiles },
    ];

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
                <span className="gha-page-sentence">
                    <Who login={actor} avatarUrl={actor === found.author ? found.avatarUrl : (found.avatars[actor ?? ""] ?? null)} />
                    <span>
                        {verb} {found.commits !== null ? plural(found.commits, "commit") + " " : ""}into
                    </span>
                    {found.base && <Branch name={found.base} />}
                    {from && (
                        <>
                            <span>from</span>
                            <Branch name={from} />
                            <Tooltip label="Copy the branch name">
                                <button
                                    type="button"
                                    className="gha-icon-btn gha-copy-branch"
                                    aria-label="Copy the branch name"
                                    onClick={() =>
                                        void copyText(found.head ?? from)
                                            .then(() => notify("success", `Copied ${found.head ?? from}`))
                                            .catch(swallow("copy the branch name"))
                                    }>
                                    <IconCopy size={12} />
                                </button>
                            </Tooltip>
                        </>
                    )}
                </span>
                <span>{formatAgo(merged ? found.mergedAt : found.createdAt, now)}</span>
            </PageHead>

            <div className="gha-tabs" role="tablist">
                {tabs.map((each) => (
                    <button
                        key={each.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === each.id}
                        className="gha-tab"
                        data-on={tab === each.id ? "1" : "0"}
                        onClick={() => setTab(each.id)}>
                        {each.label}
                        {each.count !== null && <span className="gha-tab-count">{each.count.toLocaleString()}</span>}
                    </button>
                ))}
                <span className="gha-page-spacer" />
                {found.additions !== null && (
                    <span className="gha-diffstat">
                        <span className="gha-add">+{found.additions.toLocaleString()}</span>
                        <span className="gha-del">−{(found.deletions ?? 0).toLocaleString()}</span>
                    </span>
                )}
            </div>

            {tab === "conversation" && (
                <div className="gha-pull-body">
                    <CommentThread
                        repo={repo}
                        number={found.number}
                        active={active}
                        now={now}
                        opening={{
                            key: "opening",
                            author: found.author,
                            avatarUrl: found.avatarUrl,
                            association: found.authorAssociation,
                            at: found.createdAt,
                            body: found.body,
                            review: null,
                        }}
                        base={found.base}
                        review={found.state === "open" ? { mine: !!login && found.author === login } : null}>
                        <MergeBox repo={repo} pull={found} verdict={verdict} reviewed={reviewList.length > 0} active={active} onOpenRun={onOpenRun} />
                    </CommentThread>
                    <PullSide pull={found} reviews={reviewList} participants={participants} />
                </div>
            )}
            {tab === "commits" && <CommitsTab repo={repo} number={found.number} active={active} now={now} />}
            {tab === "files" && <FilesTab repo={repo} number={found.number} active={active} />}
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
