import { useState } from "react";
import { notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { Checkbox, EmptyState, IconCheck, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type Notification } from "../api";
import { githubInboxR } from "../resources";
import { formatAgo } from "../runStatus";
import { useBusy, useNow } from "./hooks";

const REASON: Record<string, string> = {
    review_requested: "Review requested",
    mention: "Mentioned",
    team_mention: "Team mentioned",
    assign: "Assigned",
    author: "You opened it",
    comment: "New comment",
    ci_activity: "CI finished",
    state_change: "State changed",
    subscribed: "Subscribed",
    manual: "Subscribed",
};

export function reasonLabel(reason: string): string {
    return REASON[reason] ?? reason.replace(/_/gu, " ");
}

function Row({ item, now, onOpen }: { item: Notification; now: number; onOpen: () => void }) {
    return (
        <button type="button" className="gha-item-row" data-unread={item.unread ? "1" : "0"} onClick={onOpen}>
            <span className="gha-unread-dot" data-on={item.unread ? "1" : "0"} />
            <span className="gha-item-head">
                <span className="gha-item-title">{item.title}</span>
            </span>
            <span className="gha-item-sub">
                <span>{item.repo}</span>
                {item.number !== null && <span className="gha-item-number">#{item.number}</span>}
                <span>{reasonLabel(item.reason)}</span>
            </span>
            <span className="gha-item-when">{formatAgo(item.updatedAt, now)}</span>
        </button>
    );
}

export function InboxView({ active }: { active: boolean }) {
    const [all, setAll] = useState(false);
    const inbox = useResourceEnabled(active, githubInboxR, all);
    const now = useNow(false);
    const [busy, runBusy] = useBusy();

    if (inbox.status === "loading" && !inbox.data) return <SkeletonRows rows={8} label="Loading notifications" />;
    if (inbox.error) {
        return (
            <EmptyState
                title="Could not read notifications"
                message={failureMessage(inbox.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void inbox.refresh() }}
            />
        );
    }
    const rows = inbox.data ?? [];
    const unread = rows.filter((row) => row.unread).length;

    const refresh = () => invalidate((kind) => kind === "gha.inbox");
    const open = (item: Notification) => {
        if (item.url) void openUrl(item.url).catch(swallow("open GitHub"));
        if (!item.unread) return;
        void actionsApi.markRead(item.id).then(refresh).catch(swallow("mark it read"));
    };
    const readEverything = () =>
        runBusy(() =>
            actionsApi
                .markAllRead()
                .then(() => {
                    notify("success", "Inbox cleared");
                    refresh();
                })
                .catch(reportError("Could not clear the inbox")),
        );

    return (
        <div className="gha-list">
            <div className="gha-list-head">
                <Checkbox checked={all} onChange={setAll}>
                    Include read
                </Checkbox>
                <span className="gha-dim">
                    {unread} unread
                    {unread > 0 && (
                        <button type="button" className="gha-link" disabled={busy} onClick={readEverything}>
                            Mark all read
                        </button>
                    )}
                </span>
            </div>
            {rows.length === 0 ? (
                <EmptyState icon={<IconCheck size={20} />} title="Nothing waiting" message="No notifications." />
            ) : (
                rows.map((item) => <Row key={item.id} item={item} now={now} onOpen={() => open(item)} />)
            )}
        </div>
    );
}
