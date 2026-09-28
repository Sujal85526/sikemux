import { useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { actionsApi, type RepoRef, type Review, type ReviewEvent } from "../api";
import { githubCommentsR } from "../resources";
import { formatAgo } from "../runStatus";
import { Avatar, Prose } from "./Pictures";

const REVIEW_WORD: Record<string, string> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "asked for changes",
    COMMENTED: "reviewed",
    DISMISSED: "had a review dismissed",
};

const REVIEW_DONE: Record<ReviewEvent, string> = {
    APPROVE: "Approved",
    REQUEST_CHANGES: "Asked for changes on",
    COMMENT: "Reviewed",
};

interface Entry {
    key: string;
    author: string | null;
    avatarUrl: string | null;
    at: string | null;
    body: string;
    review: string | null;
}

function entriesOf(
    comments: readonly { id: number; author: string | null; avatarUrl: string | null; createdAt: string; body: string }[],
    reviews: readonly Review[],
): Entry[] {
    const entries: Entry[] = [
        ...comments.map((comment) => ({
            key: `c${comment.id}`,
            author: comment.author,
            avatarUrl: comment.avatarUrl,
            at: comment.createdAt,
            body: comment.body,
            review: null,
        })),
        ...reviews
            .filter((review) => review.state !== "COMMENTED" || review.body.trim())
            .map((review, index) => ({
                key: `r${index}-${review.author ?? ""}`,
                author: review.author,
                avatarUrl: review.avatarUrl,
                at: review.submittedAt,
                body: review.body,
                review: review.state,
            })),
    ];
    return entries.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
}

function Author({ entry }: { entry: Entry }) {
    return (
        <>
            {entry.avatarUrl ? <Avatar url={entry.avatarUrl} /> : <span className="gha-avatar" aria-hidden="true" />}
            <span className="gha-comment-author">{entry.author ?? "someone"}</span>
        </>
    );
}

interface Props {
    repo: RepoRef;
    number: number;
    active: boolean;
    now: number;
    reviews?: readonly Review[];
    /** Offers approving and asking for changes; GitHub refuses both on your own pull request. */
    review?: { mine: boolean } | null;
}

export function CommentThread({ repo, number, active, now, reviews = [], review = null }: Props) {
    const thread = useResourceEnabled(active, githubCommentsR, repo, number);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState<ReviewEvent | "comment" | null>(null);
    const entries = entriesOf(thread.data ?? [], reviews);
    const written = draft.trim().length > 0;

    const comment = async () => {
        setBusy("comment");
        try {
            await actionsApi.addComment(repo, number, draft.trim());
            setDraft("");
            invalidate((kind) => kind === "gha.comments");
            notify("success", "Comment added");
        } catch (error) {
            reportError("Could not add the comment")(error);
        } finally {
            setBusy(null);
        }
    };

    const send = async (event: ReviewEvent) => {
        setBusy(event);
        try {
            await actionsApi.reviewPull(repo, number, event, draft.trim());
            setDraft("");
            notify("success", `${REVIEW_DONE[event]} #${number}`);
            invalidate((kind) => kind === "gha.pullReviews" || kind === "gha.pull");
        } catch (error) {
            reportError("Could not send the review")(error);
        } finally {
            setBusy(null);
        }
    };

    return (
        <section className="gha-thread">
            <div className="gha-section-label">Conversation</div>
            {entries.map((entry) =>
                entry.body.trim() ? (
                    <div className="gha-comment" key={entry.key}>
                        <div className="gha-comment-head">
                            <Author entry={entry} />
                            {entry.review && (
                                <span className="gha-review-state" data-state={entry.review}>
                                    {REVIEW_WORD[entry.review] ?? entry.review.toLowerCase()}
                                </span>
                            )}
                            <span className="gha-dim">{formatAgo(entry.at, now)}</span>
                        </div>
                        <Prose>{entry.body}</Prose>
                    </div>
                ) : (
                    <div className="gha-event" key={entry.key}>
                        <Author entry={entry} />
                        <span className="gha-review-state" data-state={entry.review ?? ""}>
                            {REVIEW_WORD[entry.review ?? ""] ?? "reviewed"}
                        </span>
                        <span className="gha-dim">{formatAgo(entry.at, now)}</span>
                    </div>
                ),
            )}
            <div className="gha-composer">
                <textarea
                    className="gha-composer-box"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={review ? "Leave a comment or a review" : "Leave a comment"}
                    rows={3}
                />
                <div className="gha-composer-foot">
                    {review?.mine && <span className="gha-dim">GitHub does not let you approve your own pull request.</span>}
                    <span className="gha-page-spacer" />
                    {review && !review.mine && (
                        <button type="button" className="gha-btn" disabled={busy !== null || !written} onClick={() => void send("REQUEST_CHANGES")}>
                            Request changes
                        </button>
                    )}
                    {review && !review.mine && (
                        <button type="button" className="gha-btn" disabled={busy !== null} onClick={() => void send("APPROVE")}>
                            {busy === "APPROVE" ? "Approving…" : "Approve"}
                        </button>
                    )}
                    <button type="button" className="gha-btn primary" disabled={busy !== null || !written} onClick={() => void comment()}>
                        {busy === "comment" ? "Sending…" : "Comment"}
                    </button>
                </div>
            </div>
        </section>
    );
}
