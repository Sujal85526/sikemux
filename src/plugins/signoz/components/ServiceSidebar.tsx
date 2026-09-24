import { useMemo, useState } from "react";
import { openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { IconSearch, rankBy } from "../../../plugin-api/ui";
import { failureMessage, signozApi, type ServiceHealth, type SignozStatus } from "../api";
import { signozDashboardsR, signozServicesR } from "../resources";
import { SERVICE_SORTS, openDashboard, signozSettings, updateSettings, updateView, useExploreView, type ServiceSort } from "../state";
import { formatValue } from "./charts";

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

/** A zero error rate is the ordinary case, so it steps back instead of printing "0%". */
function errorRate(rate: number): string {
    if (rate === 0) return "";
    if (rate < 0.001) return "<0.1%";
    return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
    return (
        <section className="sgz-side-section">
            <header className="sgz-side-head">
                <span>{title}</span>
                {extra}
            </header>
            {children}
        </section>
    );
}

function Dashboards({ paneId, active }: { paneId: string; active: boolean }) {
    const view = useExploreView(paneId);
    const dashboards = useResourceEnabled(active, signozDashboardsR);
    if (dashboards.error) return <div className="sgz-muted sgz-side-note">{failureMessage(dashboards.error)}</div>;
    if (!dashboards.data) return <div className="sgz-muted sgz-side-note">reading dashboards…</div>;
    if (dashboards.data.length === 0) return <div className="sgz-muted sgz-side-note">no dashboards</div>;
    return (
        <div className="sgz-side-rows" role="listbox" aria-label="Dashboards">
            {dashboards.data.map((dashboard) => {
                const selected = view.dashboard === dashboard.id;
                return (
                    <button
                        key={dashboard.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sgz-side-row${selected ? " selected" : ""}`}
                        title={dashboard.description || dashboard.title}
                        onClick={() => openDashboard(paneId, dashboard.id)}>
                        <span className="sgz-side-name">{dashboard.title}</span>
                        <span className="sgz-side-meta">{dashboard.panels}</span>
                    </button>
                );
            })}
        </div>
    );
}

function Services({ paneId, active }: { paneId: string; active: boolean }) {
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    const sort = signozSettings.useSelect((settings) => settings.serviceSort);
    const view = useExploreView(paneId);
    const [query, setQuery] = useState("");
    const health = useResourceEnabled(active, signozServicesR, { minutes });

    const rows = useMemo(() => {
        const merged = mergeByService(health.data ?? [], environment).sort(SORTERS[sort]);
        return query.trim() ? rankBy(query.trim(), merged, (row) => row.service) : merged;
    }, [environment, health.data, query, sort]);
    const selected = view.dashboard ? undefined : view.service;
    const pick = (service: string | null) => updateView(paneId, { service, trace: null, dashboard: null });

    return (
        <Section
            title="Services"
            extra={
                <select
                    className="sgz-side-sort"
                    value={sort}
                    onChange={(event) => updateSettings({ serviceSort: event.target.value as ServiceSort })}
                    aria-label="Sort services">
                    {SERVICE_SORTS.map((option) => (
                        <option key={option} value={option}>
                            by {option}
                        </option>
                    ))}
                </select>
            }>
            <label className="sgz-search sgz-side-search">
                <IconSearch size={12} />
                <input
                    className="sgz-input"
                    placeholder="Find a service"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    spellCheck={false}
                    aria-label="Find a service"
                />
            </label>
            <div className="sgz-side-rows sgz-side-scroll" role="listbox" aria-label="Services">
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
                {health.data && rows.length === 0 && (
                    <div className="sgz-muted sgz-side-note">{query ? "no service matches" : "no traced services"}</div>
                )}
                {rows.map((row) => (
                    <button
                        key={row.service}
                        type="button"
                        role="option"
                        aria-selected={selected === row.service}
                        className={`sgz-side-row${selected === row.service ? " selected" : ""}`}
                        onClick={() => pick(selected === row.service ? null : row.service)}
                        title={`${row.calls.toLocaleString()} calls · ${row.errors.toLocaleString()} errors · p99 ${formatValue(row.p99Ms, "ms")}`}>
                        <span className="sgz-side-name">{row.service}</span>
                        <span className={`sgz-side-rate${row.errors > 0 ? " bad" : ""}`}>{errorRate(row.errorRate)}</span>
                        <span className="sgz-side-meta">{formatValue(row.p99Ms, "ms")}</span>
                    </button>
                ))}
            </div>
        </Section>
    );
}

export function ServiceSidebar({ paneId, active, status }: { paneId: string; active: boolean; status: SignozStatus }) {
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    const health = useResourceEnabled(active, signozServicesR, { minutes });
    const environments = useMemo(
        () => [...new Set((health.data ?? []).map((row) => row.environment).filter((name): name is string => !!name))].sort(),
        [health.data],
    );
    const host = status.url.replace(/^https?:\/\//, "");
    const signOut = () =>
        void signozApi
            .signOut()
            .then(() => invalidate((kind) => kind.startsWith("signoz.")))
            .catch(reportError("sign out of SigNoz"));

    return (
        <aside className="sgz-side" aria-label="SigNoz">
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
            <Section title="Dashboards">
                <Dashboards paneId={paneId} active={active} />
            </Section>
            <Services paneId={paneId} active={active} />
            <footer className="sgz-side-foot">
                <div className="sgz-side-who" title={status.url}>
                    <span className="sgz-side-host">{host}</span>
                    <span className="sgz-side-account">{status.email || "API key"}</span>
                </div>
                <button type="button" className="sgz-foot-button" onClick={() => void openUrl(status.url).catch(swallow("open SigNoz"))}>
                    Open
                </button>
                <button type="button" className="sgz-foot-button" onClick={signOut}>
                    Sign out
                </button>
            </footer>
        </aside>
    );
}
