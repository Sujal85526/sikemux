import { useEffect, useRef, useState } from "react";
import { swallow } from "../../../plugin-api/host";
import { EmptyState, IconSearch, Switch, VirtualLogList } from "../../../plugin-api/ui";
import { signozApi, type LogLine } from "../api";
import { signozSettings, updateView, useExploreView } from "../state";
import { LogRow } from "./LogRow";

const KEPT_LINES = 3_000;
const ERROR_LEVELS = ["ERROR", "FATAL"];
const TYPE_PAUSE_MS = 400;

/** Near enough to the bottom that new lines should keep it there. */
const followable = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 48;

export function LogFeed({ paneId, active }: { paneId: string; active: boolean }) {
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const [draft, setDraft] = useState(view.text);
    const [lines, setLines] = useState<LogLine[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [follow, setFollow] = useState(true);
    const followRef = useRef(follow);
    followRef.current = follow;

    useEffect(() => {
        if (draft === view.text) return;
        const timer = window.setTimeout(() => updateView(paneId, { text: draft }), TYPE_PAUSE_MS);
        return () => window.clearTimeout(timer);
    }, [draft, paneId, view.text]);

    useEffect(() => {
        if (!active) return;
        setLines([]);
        setError(null);
        let alive = true;
        let streamId: number | null = null;
        signozApi
            .tailStart(
                {
                    service: view.service ?? undefined,
                    text: view.text || undefined,
                    severities: view.errorsOnly ? ERROR_LEVELS : [],
                    minutes,
                    limit: 200,
                },
                (tick) => {
                    if (!alive) return;
                    setError(tick.error);
                    if (tick.lines.length > 0) setLines((current) => current.concat(tick.lines).slice(-KEPT_LINES));
                },
            )
            .then((id) => {
                if (alive) streamId = id;
                else void signozApi.tailStop(id);
            })
            .catch((failure: unknown) => {
                if (alive) setError(String(failure));
            });
        return () => {
            alive = false;
            if (streamId !== null) void signozApi.tailStop(streamId).catch(swallow("stop SigNoz tail"));
        };
    }, [active, view.service, view.text, view.errorsOnly, minutes]);

    const toggle = (id: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    return (
        <div className="sgz-feed">
            <div className="sgz-filters">
                <label className="sgz-search">
                    <IconSearch size={12} />
                    <input
                        className="sgz-input"
                        placeholder="text in the log line"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                    />
                </label>
                {view.service && (
                    <button
                        type="button"
                        className="sgz-chip-filter"
                        onClick={() => updateView(paneId, { service: null })}
                        title="Show every service">
                        {view.service} ×
                    </button>
                )}
                <label className="sgz-toggle">
                    <Switch checked={view.errorsOnly} onChange={(errorsOnly) => updateView(paneId, { errorsOnly })} />
                    errors only
                </label>
            </div>
            {error && <div className="sgz-banner">{error}</div>}
            <VirtualLogList
                items={lines}
                className="sgz-lines"
                rowClassName="sgz-line-slot"
                estimateSize={22}
                follow={follow}
                allowFollow={() => followRef.current}
                onScroll={(element) => setFollow(followable(element))}
                getItemKey={(line) => line.id}
                empty={<EmptyState message={view.errorsOnly ? `no errors in the last ${minutes} minutes` : "waiting for log lines"} />}
                renderRow={(line) => (
                    <LogRow
                        line={line}
                        expanded={expanded.has(line.id)}
                        onToggle={() => toggle(line.id)}
                        onOpenTrace={(trace) => updateView(paneId, { trace })}
                    />
                )}
            />
        </div>
    );
}
