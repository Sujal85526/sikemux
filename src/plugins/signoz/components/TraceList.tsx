import { useMemo, useState } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, SkeletonRows, Switch } from "../../../plugin-api/ui";
import { failureMessage, signozApi, type TraceOrder, type TraceSummary } from "../api";
import { signozTracesR } from "../resources";
import { scopeOf, signozSettings, updateView, useExploreView } from "../state";
import { logTime } from "./LogRow";
import { formatMs } from "./TraceView";

const PAGE = 100;

export function TraceList({ paneId, active }: { paneId: string; active: boolean }) {
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    const search = useMemo(
        () => ({ ...scopeOf(view, { minutes, environment }), order: view.traceOrder, errorsOnly: view.tracesErrorsOnly, limit: PAGE }),
        [view, minutes, environment],
    );
    const first = useResourceEnabled(active, signozTracesR, search);
    const [more, setMore] = useState<{ key: string; traces: TraceSummary[]; next: number | null }>({ key: "", traces: [], next: null });
    const key = JSON.stringify(search);
    const extra = more.key === key ? more : { key, traces: [], next: first.data?.nextOffset ?? null };
    const traces = [...(first.data?.traces ?? []), ...extra.traces];

    const loadMore = () => {
        if (extra.next === null) return;
        void signozApi
            .searchTraces({ ...search, offset: extra.next })
            .then((page) => setMore({ key, traces: [...extra.traces, ...page.traces], next: page.nextOffset }));
    };

    return (
        <div className="sgz-traces">
            <div className="sgz-filter-row sgz-trace-controls">
                <div className="sgz-segmented" role="group" aria-label="Order">
                    {(["slowest", "recent"] as TraceOrder[]).map((order) => (
                        <button
                            key={order}
                            type="button"
                            aria-pressed={view.traceOrder === order}
                            className={view.traceOrder === order ? "on" : ""}
                            onClick={() => updateView(paneId, { traceOrder: order })}>
                            {order}
                        </button>
                    ))}
                </div>
                <label className="sgz-toggle">
                    <Switch checked={view.tracesErrorsOnly} onChange={(tracesErrorsOnly) => updateView(paneId, { tracesErrorsOnly })} />
                    failed only
                </label>
            </div>
            <div className="sgz-trace-rows" role="list">
                {first.status === "loading" && !first.data && <SkeletonRows rows={8} label="Loading traces" />}
                {first.error && <EmptyState tone="error" message={failureMessage(first.error)} />}
                {first.data && traces.length === 0 && <EmptyState message="No traces in this window." />}
                {traces.map((trace) => (
                    <button
                        key={trace.traceId}
                        type="button"
                        role="listitem"
                        className="sgz-trace-row"
                        onClick={() => updateView(paneId, { trace: trace.traceId })}>
                        <span className="sgz-log-time">{logTime(trace.timestamp)}</span>
                        <span className={`sgz-sev ${trace.error ? "danger" : "quiet"}`}>{trace.error ? "ERROR" : (trace.statusCode ?? "")}</span>
                        <span className="sgz-log-service">{trace.service}</span>
                        <span className="sgz-trace-name">{trace.name}</span>
                        <span className="sgz-trace-duration">{formatMs(trace.durationMs)}</span>
                    </button>
                ))}
                {extra.next !== null && traces.length > 0 && (
                    <button type="button" className="sgz-older" onClick={loadMore}>
                        More traces
                    </button>
                )}
            </div>
        </div>
    );
}
