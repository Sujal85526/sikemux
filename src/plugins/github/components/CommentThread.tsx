import { useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { Markdown } from "../../../plugin-api/ui";
import { actionsApi, type RepoRef } from "../api";
import { githubCommentsR } from "../resources";
import { formatAgo } from "../runStatus";

interface Props {
    repo: RepoRef;
    number: number;
    active: boolean;
    now: number;
}

export function CommentThread({ repo, number, active, now }: Props) {
    const thread = useResourceEnabled(active, githubCommentsR, repo, number);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const comments = thread.data ?? [];

    const send = async () => {
        const body = draft.trim();
        if (!body) return;
        setBusy(true);
        try {
            await actionsApi.addComment(repo, number, body);
            setDraft("");
            invalidate((kind) => kind === "gha.comments");
            notify("success", "Comment added");
        } catch (error) {
            reportError("Could not add the comment")(error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="gha-thread">
            <div className="gha-section-label">
                {comments.length} comment{comments.length === 1 ? "" : "s"}
            </div>
            {comments.map((comment) => (
                <div className="gha-comment" key={comment.id}>
                    <div className="gha-comment-head">
                        <span className="gha-comment-author">{comment.author ?? "someone"}</span>
                        <span className="gha-dim">{formatAgo(comment.createdAt, now)}</span>
                    </div>
                    <Markdown>{comment.body}</Markdown>
                </div>
            ))}
            <textarea
                className="gha-input gha-comment-box"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Leave a comment"
                rows={3}
            />
            <div className="gha-detail-actions">
                <button type="button" className="gha-btn primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
                    {busy ? "Sending…" : "Comment"}
                </button>
            </div>
        </div>
    );
}
