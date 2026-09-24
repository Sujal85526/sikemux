import { useMemo, useState } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { IconSearch, rankBy } from "../../../plugin-api/ui";
import { failureMessage, type ServiceHealth } from "../api";
import { signozServicesR } from "../resources";
import { SERVICE_SORTS, signozSettings, updateSettings, updateView, useExploreView, type ServiceSort } from "../state";
import { formatMs } from "./TraceView";

interface ServiceRow {
    service: string;
    calls: number;
    errors: number;
    errorRate: number;
    p99Ms: number;
}

/** One row per service. Across environments the counts add up and the worst p99 stands. */
export function mergeByService(rows: readonly ServiceHealth[], environment: string | null): ServiceRow[] {
    const merged = new Map<string, ServiceRow>();
    for (const row of rows) {
        if (environment !== null && row.environment !== environment) continue;
        const current = merged.get(row.service);
        if (!current) {
            merged.set(row.service, { service: row.service, calls: row.calls, errors: row.errors, errorRate: row.errorRate, p99Ms: row.p99Ms });
            continue;
        }
        current.calls += row.calls;
        current.errors += row.errors;
        current.errorRate = current.calls === 0 ? 0 : current.errors / current.calls;
        current.p99Ms = Math.max(current.p99Ms, row.p99Ms);
    }
    return [...merged.values()];
}

const SORTERS: Record<ServiceSort, (left: ServiceRow, right: ServiceRow) => number> = {
    errors: (left, right) => right.errorRate - left.errorRate || right.errors - left.errors || right.calls - left.calls,
    calls: (left, right) => right.calls - left.calls,
    p99: (left, right) => right.p99Ms - left.p99Ms,
    name: (left, right) => left.service.localeCompare(right.service),
};

function percent(rate: number): string {
    if (rate === 0) return "0%";
    return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
}

export function ServiceSidebar({ paneId, active }: { paneId: string; active: boolean }) {
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    const sort = signozSettings.useSelect((settings) => settings.serviceSort);
    const selected = useExploreView(paneId).service;
    const [query, setQuery] = useState("");
    const health = useResourceEnabled(active, signozServicesR, { minutes });

    const environments = useMemo(
        () => [...new Set((health.data ?? []).map((row) => row.environment).filter((name): name is string => !!name))].sort(),
        [health.data],
    );
    const rows = useMemo(() => {
        const merged = mergeByService(health.data ?? [], environment).sort(SORTERS[sort]);
        return query.trim() ? rankBy(query.trim(), merged, (row) => row.service) : merged;
    }, [environment, health.data, query, sort]);

    const pick = (service: string | null) => updateView(paneId, { service, trace: null });

    return (
        <aside className="sgz-side" aria-label="Services">
            <select
                className="sgz-input sgz-side-env"
                value={environment ?? ""}
                onChange={(event) => updateSettings({ environment: event.target.value || null })}
                aria-label="Environment">
                <option value="">All environments</option>
                {environments.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
            <label className="sgz-search">
                <IconSearch size={12} />
                <input
                    className="sgz-input"
                    placeholder="services"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    spellCheck={false}
                    aria-label="Filter services"
                />
            </label>
            <div className="sgz-side-head">
                <span>Services</span>
                <select
                    className="sgz-side-sort"
                    value={sort}
                    onChange={(event) => updateSettings({ serviceSort: event.target.value as ServiceSort })}
                    aria-label="Sort services">
                    {SERVICE_SORTS.map((option) => (
                        <option key={option} value={option}>
                            {option}
                        </option>
                    ))}
                </select>
            </div>
            <div className="sgz-side-list" role="listbox" aria-label="Services">
                <button
                    type="button"
                    role="option"
                    aria-selected={selected === null}
                    className={`sgz-side-row${selected === null ? " selected" : ""}`}
                    onClick={() => pick(null)}>
                    <span className="sgz-side-name">All services</span>
                </button>
                {health.status === "loading" && !health.data && <div className="sgz-muted sgz-side-note">reading services…</div>}
                {health.error && <div className="sgz-error sgz-side-note">{failureMessage(health.error)}</div>}
                {health.data && rows.length === 0 && <div className="sgz-muted sgz-side-note">no traced services</div>}
                {rows.map((row) => (
                    <button
                        key={row.service}
                        type="button"
                        role="option"
                        aria-selected={selected === row.service}
                        className={`sgz-side-row${selected === row.service ? " selected" : ""}`}
                        onClick={() => pick(selected === row.service ? null : row.service)}
                        title={`${row.calls} calls, ${row.errors} errors, p99 ${formatMs(row.p99Ms)}`}>
                        <span className="sgz-side-name">{row.service}</span>
                        <span className={`sgz-side-rate${row.errors > 0 ? " bad" : ""}`}>{percent(row.errorRate)}</span>
                        <span className="sgz-side-p99">{formatMs(row.p99Ms)}</span>
                    </button>
                ))}
            </div>
        </aside>
    );
}
