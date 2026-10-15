import { useState } from "react";
import { notify } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { ContextMenu, EmptyState, IconRefresh, IconSearch, SkeletonRows, useCardDrag, type ContextMenuItem } from "../../../plugin-api/ui";
import { failureMessage, jiraApi, type JiraBoardView, type JiraColumn, type JiraIssueSummary } from "../api";
import { boardPeople, matchingCards, pickKey, unassignedCount } from "../boardFilter";
import { jiraBoardR } from "../resources";
import { Avatar, JiraFace } from "./JiraFace";
import { IssueKey, IssueTypeIcon, PriorityGlyph } from "./JiraGlyphs";

const FACES = 6;

/** Where each card sits after the moves still on their way to Jira, by issue key and column index. */
export function withMoves(board: JiraBoardView, moves: Record<string, number>): JiraColumn[] {
    const moving = new Set(Object.keys(moves));
    return board.columns.map((column, index) => ({
        ...column,
        issues: [
            ...column.issues.filter((issue) => !moving.has(issue.key)),
            ...board.columns.flatMap((other) => other.issues.filter((issue) => moves[issue.key] === index)),
        ],
    }));
}

/** How long is left in a sprint, in the words a standup uses. */
export function sprintLeft(end: string | null, now = Date.now()): string | null {
    if (!end) return null;
    const left = Date.parse(end) - now;
    if (Number.isNaN(left)) return null;
    if (left < 0) return "ended";
    const days = Math.floor(left / 86_400_000);
    if (days === 0) return "ends today";
    return days === 1 ? "1 day left" : `${days} days left`;
}

export function JiraBoard({
    active,
    boardId,
    site,
    selected,
    onSelect,
}: {
    active: boolean;
    boardId: number;
    site: string;
    selected: string | null;
    onSelect: (key: string) => void;
}) {
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    const [words, setWords] = useState("");
    const [everyone, setEveryone] = useState(false);
    const whole = useResourceEnabled(active, jiraBoardR, boardId, site, "");
    const found = useResourceEnabled(active, jiraBoardR, boardId, site, pickKey(picked));
    const [moves, setMoves] = useState<Record<string, number>>({});
    const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
    const drag = useCardDrag((key, column) => {
        const issue = columns.flatMap((each) => each.issues).find((each) => each.key === key);
        if (issue) void move(issue, Number(column));
    });

    if (whole.status === "error") return <EmptyState message={whole.error ?? "Jira could not open this board."} tone="error" />;
    if (!whole.data) return <SkeletonRows rows={6} label="Loading the board" />;
    const board = whole.data;
    const narrowed = picked.size === 0 ? board : found.data;
    const columns = narrowed ? matchingCards(withMoves(narrowed, moves), words) : [];
    const refresh = () => invalidate((kind) => kind === "jira.board");
    const toggle = (who: string) =>
        setPicked((now) => {
            const next = new Set(now);
            if (!next.delete(who)) next.add(who);
            return next;
        });
    const nobody = unassignedCount(whole.data);
    const people = boardPeople(whole.data);
    const hidden = everyone ? 0 : Math.max(0, people.length - FACES);
    const faces = people.filter((person, index) => index < people.length - hidden || picked.has(person.accountId));

    const move = async (issue: JiraIssueSummary, to: number) => {
        const from = columns.findIndex((column) => column.issues.some((each) => each.key === issue.key));
        const target = board.columns[to];
        if (from === to || !target) return;
        setMoves((now) => ({ ...now, [issue.key]: to }));
        try {
            await jiraApi.moveIssue(issue.key, target, site || undefined);
            refresh();
            await found.refresh();
            invalidate((kind) => kind === "jira.search" || kind === "jira.issue");
        } catch (error) {
            notify("error", `Move ${issue.key}: ${failureMessage(error)}`);
        } finally {
            setMoves((now) => {
                const next = { ...now };
                delete next[issue.key];
                return next;
            });
        }
    };

    const left = sprintLeft(board.sprint?.end ?? null);

    return (
        <section className="kanban jira-board" aria-label={board.name}>
            <header className="kanban-head">
                <div className="kanban-title">
                    <h2>{board.name}</h2>
                    <span className="kanban-tag">{board.kind}</span>
                    {board.sprint && (
                        <span className="kanban-meta">
                            {board.sprint.name}
                            {left && ` · ${left}`}
                        </span>
                    )}
                    <span className="kanban-grow" />
                    <button type="button" className="kanban-icon-button" title="Refresh" aria-label="Refresh the board" onClick={refresh}>
                        <IconRefresh size={13} />
                    </button>
                </div>
                {board.sprint?.goal && <p className="kanban-goal">{board.sprint.goal}</p>}
                {(narrowed ?? board).truncated && (
                    <p className="kanban-meta">Showing the first 300 issues. Pick people or narrow the board in Jira to see the rest.</p>
                )}
                <div className="kanban-filters" role="group" aria-label="Filter the board">
                    <span className="jira-board-search">
                        <IconSearch size={13} />
                        <input
                            className="kanban-search"
                            value={words}
                            onChange={(event) => setWords(event.target.value)}
                            placeholder="Find a card"
                            aria-label="Find a card"
                            spellCheck={false}
                        />
                    </span>
                    <span className="jira-board-people">
                        {faces.map((person) => (
                            <button
                                key={person.accountId}
                                type="button"
                                className="jira-avatar jira-avatar-pick"
                                title={`${person.name} · ${person.count}`}
                                aria-label={person.name}
                                aria-pressed={picked.has(person.accountId)}
                                onClick={() => toggle(person.accountId)}>
                                <JiraFace person={person} />
                            </button>
                        ))}
                        {hidden > 0 && (
                            <button
                                type="button"
                                className="jira-avatar jira-avatar-pick jira-avatar-more"
                                title={`Show ${hidden} more`}
                                aria-label={`Show ${hidden} more`}
                                onClick={() => setEveryone(true)}>
                                +{hidden}
                            </button>
                        )}
                    </span>
                    <button type="button" className="kanban-pick" aria-pressed={picked.has("me")} onClick={() => toggle("me")}>
                        Only my issues
                    </button>
                    {nobody > 0 && (
                        <button type="button" className="kanban-pick" aria-pressed={picked.has("none")} onClick={() => toggle("none")}>
                            Unassigned <span className="kanban-pick-count">{nobody}</span>
                        </button>
                    )}
                    {(picked.size > 0 || words) && (
                        <button
                            type="button"
                            className="kanban-clear"
                            onClick={() => {
                                setPicked(new Set());
                                setWords("");
                            }}>
                            Clear
                        </button>
                    )}
                </div>
            </header>
            {board.kind === "scrum" && !board.sprint ? (
                <EmptyState message="No sprint is running on this board." />
            ) : found.status === "error" && picked.size > 0 ? (
                <EmptyState message={found.error ?? "Jira could not narrow the board to those people."} tone="error" />
            ) : !narrowed ? (
                <SkeletonRows rows={6} label="Loading their cards" />
            ) : (
                <div className="kanban-columns">
                    {columns.map((column, index) => (
                        <div
                            key={column.name}
                            className={`kanban-column${drag.dragging?.over === String(index) ? " drop" : ""}`}
                            data-column={index}
                            role="list"
                            aria-label={column.name}>
                            <div className="kanban-column-head">
                                <span className="jira-column-name">{column.name}</span>
                                <span className="kanban-count">{column.issues.length}</span>
                            </div>
                            {column.issues.map((issue) => (
                                <button
                                    key={issue.key}
                                    type="button"
                                    role="listitem"
                                    className={`kanban-card${issue.key === selected ? " active" : ""}${drag.dragging?.card === issue.key ? " dragging" : ""}${issue.key in moves ? " moving" : ""}`}
                                    onPointerDown={(event) => drag.startDrag(event, issue.key)}
                                    onClick={() => {
                                        if (!drag.wasDragged()) onSelect(issue.key);
                                    }}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        setMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            items: board.columns.map((target, to) => ({
                                                label: `Move to ${target.name}`,
                                                disabled: to === index,
                                                run: () => void move(issue, to),
                                            })),
                                        });
                                    }}>
                                    <span className="kanban-card-summary">{issue.summary}</span>
                                    <span className="kanban-card-foot">
                                        <IssueTypeIcon type={issue.issueType} />
                                        <IssueKey issue={issue} className="kanban-key" />
                                        <PriorityGlyph priority={issue.priority} />
                                        <span className="kanban-grow" />
                                        <Avatar person={issue.assignee} />
                                    </span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </section>
    );
}
