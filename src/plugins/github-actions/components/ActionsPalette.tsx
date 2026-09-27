import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveSurfacePane } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { IconSearch, rankBy, useMouseActive } from "../../../plugin-api/ui";
import type { RepoListing, Workflow } from "../api";
import { ACTIONS_RUNS } from "../kinds";
import { actionsMyReposR, actionsWorkflowsR } from "../resources";
import { closePalette, filterBy, refOf, showRepo, STATUS_FILTERS, updateView, useRunsView, type StatusFilter } from "../state";
import { GithubMark } from "./ActionsIcon";

const FILTER_LABEL: Record<StatusFilter, string> = {
    all: "All runs",
    in_progress: "Running now",
    queued: "Queued",
    success: "Passed",
    failure: "Failed",
    cancelled: "Cancelled",
};

export interface PaletteItem {
    id: string;
    label: string;
    hint?: string;
    run: (paneId: string) => void;
}

/** Everything the palette can do for a pane, before the query narrows it. */
export function paletteItems(query: string, repos: readonly RepoListing[], workflows: readonly Workflow[]): PaletteItem[] {
    const typed = query.trim();
    const filters: PaletteItem[] = STATUS_FILTERS.map((filter) => ({
        id: `filter:${filter}`,
        label: FILTER_LABEL[filter],
        hint: "filter",
        run: (paneId) => filterBy(paneId, { statusFilter: filter }),
    }));
    const workflowItems: PaletteItem[] = workflows.map((workflow) => ({
        id: `workflow:${workflow.id}`,
        label: workflow.name,
        hint: "workflow",
        run: (paneId) => filterBy(paneId, { workflowId: workflow.id }),
    }));
    const repoItems: PaletteItem[] = repos.map((repo) => ({
        id: `repo:${repo.slug}`,
        label: repo.slug,
        hint: "repo",
        run: (paneId) => showRepo(paneId, { owner: repo.owner, name: repo.name }),
    }));
    const back: PaletteItem = { id: "back", label: "Back to runs", run: (paneId) => updateView(paneId, { run: null, job: null }) };

    const everything = [...workflowItems, ...repoItems, ...filters, back];
    const ranked = typed ? rankBy(typed, everything, (item) => item.label) : [...filters, back, ...workflowItems, ...repoItems];

    // Anything shaped like owner/repo is offered even when it is not a
    // repository this account has listed.
    const typedRepo = refOf(typed);
    if (!typedRepo || repos.some((repo) => repo.slug === typed)) return ranked;
    return [{ id: `open:${typed}`, label: `Open ${typed}`, hint: "repo", run: (paneId) => showRepo(paneId, typedRepo) }, ...ranked];
}

export function Palette() {
    const paneId = useActiveSurfacePane(ACTIONS_RUNS);
    const view = useRunsView(paneId ?? "");
    const repos = useResourceEnabled(true, actionsMyReposR);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const mouseActive = useMouseActive();
    const listRef = useRef<HTMLDivElement>(null);

    const workflows = useResourceEnabled(!!view.repo, actionsWorkflowsR, view.repo ?? { owner: "", name: "" });
    const items = useMemo(() => paletteItems(query, repos.data ?? [], workflows.data ?? []), [query, repos.data, workflows.data]);

    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`.picker-item:nth-child(${selected + 1})`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const activate = (item: PaletteItem | undefined) => {
        if (!item || !paneId) return;
        item.run(paneId);
        closePalette();
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "Escape") closePalette();
        else if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
            event.preventDefault();
            setSelected((index) => (items.length ? (index + 1) % items.length : 0));
        } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
            event.preventDefault();
            setSelected((index) => (items.length ? (index - 1 + items.length) % items.length : 0));
        } else if (event.key === "Enter") {
            event.preventDefault();
            activate(items[selected]);
        }
    };

    return (
        <div className="picker-backdrop" onMouseDown={closePalette}>
            <div className="picker" onMouseDown={(event) => event.stopPropagation()}>
                <div className="picker-input-wrap">
                    <IconSearch size={15} className="picker-search-icon" />
                    <input
                        className="picker-input"
                        placeholder="Repositories, workflows, filters…"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setSelected(0);
                        }}
                        onKeyDown={onKeyDown}
                        autoFocus
                        spellCheck={false}
                    />
                </div>
                <div className="picker-list" ref={listRef}>
                    {items.length === 0 && <div className="picker-empty">no matches</div>}
                    {items.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            className={`picker-item${index === selected ? " sel" : ""}`}
                            onMouseEnter={() => {
                                if (mouseActive.current) setSelected(index);
                            }}
                            onClick={() => activate(item)}>
                            <span className="picker-icon command">
                                <GithubMark size={14} />
                            </span>
                            <span className="picker-name">{item.label}</span>
                            {item.hint && (
                                <span className="picker-tags">
                                    <span className="picker-tag type">{item.hint}</span>
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
