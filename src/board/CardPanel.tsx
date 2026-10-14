import { useState } from "react";
import type { BoardCard, CardChanges, CardStatus, NewCard } from "../agents/agentBoard";
import { agentBoardApi } from "../api/agentBoard";
import { openInBrowser } from "../api/releases";
import * as cmd from "../state/commands";
import { confirmDialog } from "../state/dialog";
import { reportError } from "../state/toast";
import { Dropdown, type DropdownOption } from "../ui/Dropdown";
import { IconClose, IconExternal } from "../ui/Icons";
import { Owner, shortTitle } from "./cardParts";

const STATUS_OPTIONS: DropdownOption[] = [
    { value: "open", label: "Open" },
    { value: "progress", label: "In progress" },
    { value: "done", label: "Done" },
];

const TOP = "0";

/** The cards under `id`, and theirs, which it cannot be put under. */
function below(cards: readonly BoardCard[], id: number): Set<number> {
    const found = new Set<number>([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const card of cards) {
            if (card.parent !== null && found.has(card.parent) && !found.has(card.id)) {
                found.add(card.id);
                grew = true;
            }
        }
    }
    return found;
}

/** A card opened beside the board, to read and change; or a new one, when `card` is null. */
export function CardPanel({
    folder,
    card,
    cards,
    onSelect,
    onClose,
}: {
    folder: string;
    card: BoardCard | null;
    cards: readonly BoardCard[];
    onSelect: (id: number) => void;
    onClose: () => void;
}) {
    const [title, setTitle] = useState(card?.title ?? "");
    const [details, setDetails] = useState(card?.details ?? "");
    const [parent, setParent] = useState(card?.parent ?? 0);
    const [dependsOn, setDependsOn] = useState<number[]>(card?.dependsOn ?? []);
    const [busy, setBusy] = useState(false);

    const run = async (label: string, work: () => Promise<{ project: string; cards: BoardCard[] }>) => {
        setBusy(true);
        try {
            const board = await work();
            cmd.setAgentBoard(folder, board);
            return board;
        } catch (error) {
            reportError(label)(error);
            return null;
        } finally {
            setBusy(false);
        }
    };
    const change = (changes: CardChanges) => {
        if (card) void run("change the card", () => agentBoardApi.update(folder, card.id, changes));
    };

    const unplaceable = card ? below(cards, card.id) : new Set<number>();
    const parentOptions: DropdownOption[] = [
        { value: TOP, label: "No card" },
        ...cards.filter((other) => !unplaceable.has(other.id)).map((other) => ({ value: String(other.id), label: other.title })),
    ];
    const waitOptions: DropdownOption[] = cards
        .filter((other) => other.id !== card?.id && !dependsOn.includes(other.id))
        .map((other) => ({ value: String(other.id), label: other.title }));
    const nameOf = (id: number) => cards.find((other) => other.id === id)?.title ?? `card ${id}`;
    const setWaits = (next: number[]) => {
        setDependsOn(next);
        change({ dependsOn: next });
    };
    const under = card ? cards.filter((other) => other.parent === card.id) : [];

    const add = async () => {
        const fresh: NewCard = {
            title: title.trim(),
            details: details.trim() || undefined,
            parent: parent || undefined,
            dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        };
        const board = await run("add the card", () => agentBoardApi.add(folder, fresh));
        if (!board) return;
        const made = board.cards.reduce<BoardCard | null>((last, each) => (!last || each.id > last.id ? each : last), null);
        if (made) onSelect(made.id);
        else onClose();
    };

    const remove = async () => {
        if (!card) return;
        const sure = await confirmDialog({
            title: `Take “${card.title}” off the board?`,
            body: card.owner && card.status === "progress" ? `${card.ownerName ?? "The agent working it"} is told to stop working on it.` : undefined,
            confirmLabel: "Remove",
            destructive: true,
        });
        if (sure && (await run("remove the card", () => agentBoardApi.remove(folder, card.id)))) onClose();
    };

    return (
        <aside className="board-card-panel" aria-label={card ? card.title : "New card"}>
            <header className="board-panel-head">
                {card?.ticket ? (
                    <span className="board-panel-ticket">
                        <span className="kanban-key">{card.ticket.key}</span>
                        {card.ticket.source && <span className="kanban-meta">{card.ticket.source}</span>}
                        {card.ticket.url && (
                            <button
                                type="button"
                                className="kanban-icon-button"
                                title="Open in browser"
                                aria-label="Open the ticket in the browser"
                                onClick={() => void openInBrowser(card.ticket!.url!)}>
                                <IconExternal size={12} />
                            </button>
                        )}
                    </span>
                ) : (
                    <span className="kanban-meta">{card ? `Added by ${card.createdByName}` : "New card"}</span>
                )}
                <span className="kanban-grow" />
                <button type="button" className="kanban-icon-button" title="Close" aria-label="Close the card" onClick={onClose}>
                    <IconClose size={12} />
                </button>
            </header>
            <input
                className="board-panel-title"
                value={title}
                autoFocus={!card}
                placeholder="What needs doing"
                aria-label="Title"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                    if (card && title.trim() && title.trim() !== card.title) change({ title: title.trim() });
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Enter" && !card && title.trim()) void add();
                }}
            />
            <div className="board-facts">
                {card && (
                    <>
                        <span className="board-fact">
                            <span className="board-fact-name">Status</span>
                            <Dropdown
                                value={card.status}
                                options={STATUS_OPTIONS}
                                disabled={busy}
                                onChange={(status) => change({ status: status as CardStatus })}
                            />
                        </span>
                        <span className="board-fact">
                            <span className="board-fact-name">Owner</span>
                            {card.owner ? (
                                <Owner id={card.owner} name={card.ownerName} cli={card.ownerCli} />
                            ) : (
                                <span className="board-nobody">Nobody yet</span>
                            )}
                        </span>
                    </>
                )}
                <span className="board-fact">
                    <span className="board-fact-name">Under</span>
                    <Dropdown
                        value={String(parent)}
                        options={parentOptions}
                        disabled={busy}
                        search={parentOptions.length > 8 ? "Find a card" : undefined}
                        onChange={(value) => {
                            setParent(Number(value));
                            change({ parent: Number(value) });
                        }}
                    />
                </span>
                <span className="board-fact board-waits">
                    <span className="board-fact-name">After</span>
                    {dependsOn.map((id) => (
                        <span key={id} className="board-wait">
                            {shortTitle(nameOf(id))}
                            <button
                                type="button"
                                className="kanban-icon-button"
                                aria-label={`No longer wait on ${nameOf(id)}`}
                                disabled={busy}
                                onClick={() => setWaits(dependsOn.filter((other) => other !== id))}>
                                <IconClose size={10} />
                            </button>
                        </span>
                    ))}
                    {waitOptions.length > 0 && (
                        <Dropdown
                            value={dependsOn.length > 0 ? "Add…" : "Nothing"}
                            label="Wait on another card"
                            options={waitOptions}
                            disabled={busy}
                            search={waitOptions.length > 8 ? "Find a card" : undefined}
                            onChange={(value) => setWaits([...dependsOn, Number(value)])}
                        />
                    )}
                </span>
            </div>
            <textarea
                className="board-panel-details"
                value={details}
                placeholder="Details: what done looks like, files, constraints"
                aria-label="Details"
                rows={8}
                onChange={(event) => setDetails(event.target.value)}
                onBlur={() => {
                    if (card && details.trim() !== card.details) change({ details: details.trim() });
                }}
            />
            {card?.result && (
                <section className="board-result">
                    <span className="board-section-name">Result</span>
                    <p>{card.result}</p>
                </section>
            )}
            {under.length > 0 && (
                <section className="board-under" aria-label="Cards under it">
                    <span className="board-section-name">Cards under it</span>
                    {under.map((each) => (
                        <button key={each.id} type="button" className="board-under-row" onClick={() => onSelect(each.id)}>
                            <span>{each.title}</span>
                            <span className="kanban-meta">{STATUS_OPTIONS.find((option) => option.value === each.status)?.label}</span>
                        </button>
                    ))}
                </section>
            )}
            <footer className="board-panel-foot">
                {card ? (
                    <button type="button" className="kanban-button danger" disabled={busy} onClick={() => void remove()}>
                        Remove from board
                    </button>
                ) : (
                    <button type="button" className="kanban-button primary" disabled={busy || !title.trim()} onClick={() => void add()}>
                        Add card
                    </button>
                )}
            </footer>
        </aside>
    );
}
