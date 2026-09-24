import { useEffect, useMemo, useRef, useState } from "react";
import { swallow } from "../../../plugin-api/host";
import { EmptyState, VirtualLogList } from "../../../plugin-api/ui";
import { failureMessage, signozApi, type LogLine, type LogSearch } from "../api";
import { addFilter, scopeOf, signozSettings, updateView, useExploreView } from "../state";
import { LogRow } from "./LogRow";

const KEPT_LINES = 3_000;
const PAGE = 200;

/** Near enough to the bottom that new lines should keep it there. */
const followable = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 48;

function useLogSearch(paneId: string): LogSearch {
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    return useMemo(
        () => ({ ...scopeOf(view, { minutes, environment }), text: view.text || undefined, severities: view.severities }),
        [view, minutes, environment],
    );
}

/** Streams new lines while live. Held still, reads the window page by page, back from its end. */
function useLines(paneId: string, active: boolean, search: LogSearch, live: boolean) {
    const [lines, setLines] = useState<LogLine[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [olderAt, setOlderAt] = useState<number | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const key = JSON.stringify(search);

    useEffect(() => {
        if (!active) return;
        setLines([]);
        setError(null);
        setOlderAt(null);
        let alive = true;
        if (!live) {
            signozApi
                .searchLogs({ ...search, limit: PAGE, offset: 0 })
                .then((page) => {
                    if (!alive) return;
                    setLines([...page.lines].reverse());
                    setOlderAt(page.nextOffset);
                })
                .catch((failure: unknown) => alive && setError(failureMessage(failure)));
            return () => {
                alive = false;
            };
        }
        let streamId: number | null = null;
        signozApi
            .tailStart({ ...search, limit: PAGE }, (tick) => {
                if (!alive) return;
                setError(tick.error);
                if (tick.lines.length > 0) setLines((current) => current.concat(tick.lines).slice(-KEPT_LINES));
            })
            .then((id) => {
                if (alive) streamId = id;
                else void signozApi.tailStop(id);
            })
            .catch((failure: unknown) => alive && setError(failureMessage(failure)));
        return () => {
            alive = false;
            if (streamId !== null) void signozApi.tailStop(streamId).catch(swallow("stop SigNoz tail"));
        };
        // The search is compared by value: a new object with the same filters is the same feed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, key, live, paneId]);

    const loadOlder = () => {
        if (olderAt === null || loadingOlder) return;
        setLoadingOlder(true);
        signozApi
            .searchLogs({ ...search, limit: PAGE, offset: olderAt })
            .then((page) => {
                setLines((current) => [...page.lines].reverse().concat(current));
                setOlderAt(page.nextOffset);
            })
            .catch((failure: unknown) => setError(failureMessage(failure)))
            .finally(() => setLoadingOlder(false));
    };

    return { lines, error, canLoadOlder: olderAt !== null, loadingOlder, loadOlder };
}

export function LogFeed({ paneId, active }: { paneId: string; active: boolean }) {
    const view = useExploreView(paneId);
    const search = useLogSearch(paneId);
    const { lines, error, canLoadOlder, loadingOlder, loadOlder } = useLines(paneId, active, search, view.live);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [follow, setFollow] = useState(true);
    const followRef = useRef(follow);
    followRef.current = follow && view.live;

    const toggle = (id: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const quiet = view.severities.length > 0 && view.severities.every((severity) => severity === "ERROR" || severity === "FATAL");
    return (
        <div className="sgz-feed">
            {error && <div className="sgz-banner">{error}</div>}
            {!view.live && canLoadOlder && (
                <button type="button" className="sgz-older" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "loading…" : "Load older lines"}
                </button>
            )}
            <VirtualLogList
                items={lines}
                className="sgz-lines"
                rowClassName="sgz-line-slot"
                estimateSize={22}
                follow={view.live && follow}
                allowFollow={() => followRef.current}
                onScroll={(element) => setFollow(followable(element))}
                getItemKey={(line) => line.id}
                empty={
                    <EmptyState
                        message={quiet ? "No errors in this window." : view.live ? "Waiting for log lines." : "No log lines in this window."}
                    />
                }
                renderRow={(line) => (
                    <LogRow
                        line={line}
                        expanded={expanded.has(line.id)}
                        onToggle={() => toggle(line.id)}
                        onOpenTrace={(trace) => updateView(paneId, { trace })}
                        onFilter={(key, value, keep) => addFilter(paneId, { key, op: keep ? "equals" : "not-equals", value })}
                    />
                )}
            />
        </div>
    );
}
