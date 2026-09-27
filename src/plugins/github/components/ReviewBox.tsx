import { useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate } from "../../../plugin-api/resources";
import { actionsApi, type RepoRef, type ReviewEvent } from "../api";

const DONE: Record<ReviewEvent, string> = {
    APPROVE: "Approved",
    REQUEST_CHANGES: "Asked for changes",
    COMMENT: "Review sent",
};

interface Props {
    repo: RepoRef;
    number: number;
    mine: boolean;
}

/** Approving, asking for changes, or leaving a review, without opening GitHub. */
export function ReviewBox({ repo, number, mine }: Props) {
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState<ReviewEvent | null>(null);
    const written = draft.trim().length > 0;

    const send = async (event: ReviewEvent) => {
        setBusy(event);
        try {
            await actionsApi.reviewPull(repo, number, event, draft.trim());
            setDraft("");
            notify("success", `${DONE[event]} #${number}`);
            invalidate((kind) => kind === "gha.pullReviews" || kind === "gha.pull");
        } catch (error) {
            reportError("Could not send the review")(error);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="gha-review">
            <div className="gha-section-label">Review</div>
            <textarea
                className="gha-input gha-comment-box"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={mine ? "GitHub does not let you approve your own pull request, but you can still comment" : "What did you think?"}
                rows={3}
            />
            <div className="gha-detail-actions">
                {!mine && (
                    <button type="button" className="gha-btn" disabled={busy !== null} onClick={() => void send("APPROVE")}>
                        {busy === "APPROVE" ? "Approving…" : "Approve"}
                    </button>
                )}
                {!mine && (
                    <button type="button" className="gha-btn" disabled={busy !== null || !written} onClick={() => void send("REQUEST_CHANGES")}>
                        Request changes
                    </button>
                )}
                <button type="button" className="gha-btn" disabled={busy !== null || !written} onClick={() => void send("COMMENT")}>
                    Comment as a review
                </button>
            </div>
        </div>
    );
}
