import type { StatusCategory } from "../api";
import "../jiraChip.css";

/** A status, coloured by the bucket Jira puts it in: to do, in progress or done. */
export function StatusChip({ status, category }: { status: string; category: StatusCategory }) {
    return <span className={`jira-status jira-status-${category || "new"}`}>{status}</span>;
}
