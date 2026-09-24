import { useMemo } from "react";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, SkeletonRows } from "../../../plugin-api/ui";
import { signozDashboardsR, signozStatusR } from "../resources";
import { WINDOWS, scopeOf, setLive, signozSettings, updateSettings, updateView, useExploreView, type ExploreTab } from "../state";
import { DashboardView } from "./DashboardView";
import { FilterBar } from "./FilterBar";
import { LogFeed } from "./LogFeed";
import { ServiceSidebar } from "./ServiceSidebar";
import { SignozSignIn } from "./SignozSignIn";
import { TraceList } from "./TraceList";
import { TraceView } from "./TraceView";
import { timeLabel } from "./charts";
import "../signoz.css";

const refreshAll = () => invalidate((kind) => kind.startsWith("signoz."));

export function windowLabel(minutes: number): string {
    if (minutes >= 1440) return `${minutes / 1440}d`;
    return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

const TABS: { id: ExploreTab; label: string }[] = [
    { id: "logs", label: "Logs" },
    { id: "traces", label: "Traces" },
];

function TimeControls({ paneId }: { paneId: string }) {
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const pausedAt = view.range ?? (view.fixedEnd ? { start: view.fixedEnd - minutes * 60_000, end: view.fixedEnd } : null);
    return (
        <div className="sgz-time">
            <div className="sgz-segmented" role="group" aria-label="Time window">
                {WINDOWS.map((option) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={!view.range && minutes === option}
                        className={!view.range && minutes === option ? "on" : ""}
                        onClick={() => {
                            updateSettings({ minutes: option });
                            if (view.range) setLive(paneId, view.live);
                        }}>
                        {windowLabel(option)}
                    </button>
                ))}
            </div>
            <button
                type="button"
                className={`sgz-live${view.live ? " on" : ""}`}
                aria-pressed={view.live}
                onClick={() => setLive(paneId, !view.live)}
                title={view.live ? "Following new data. Click to hold still." : "Held still. Click to follow new data."}>
                <span className="sgz-live-dot" aria-hidden="true" />
                {view.live
                    ? "Live"
                    : pausedAt
                      ? `${timeLabel(pausedAt.start, pausedAt.end - pausedAt.start)} – ${timeLabel(pausedAt.end, pausedAt.end - pausedAt.start)}`
                      : "Paused"}
            </button>
        </div>
    );
}

export function SignozPane({ paneId, active }: { paneId: string; active: boolean }) {
    const status = useResourceEnabled(active, signozStatusR);
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const environment = signozSettings.useSelect((settings) => settings.environment);
    const dashboards = useResourceEnabled(active && !!view.dashboard, signozDashboardsR);
    const scope = useMemo(() => scopeOf(view, { minutes, environment }), [view, minutes, environment]);

    if (!status.data) {
        return (
            <div className="sgz-pane">
                {status.error ? <EmptyState tone="error" message={String(status.error)} /> : <SkeletonRows rows={6} label="Connecting to SigNoz" />}
            </div>
        );
    }
    if (!status.data.ok) {
        return (
            <div className="sgz-pane">
                <SignozSignIn status={status.data} onSignedIn={refreshAll} />
            </div>
        );
    }

    const dashboardTitle = view.dashboard ? (dashboards.data?.find((dashboard) => dashboard.id === view.dashboard)?.title ?? "Dashboard") : null;
    const title = dashboardTitle ?? view.service ?? "All services";

    return (
        <div className="sgz-pane sgz-layout">
            <ServiceSidebar paneId={paneId} active={active} status={status.data} />
            <section className="sgz-main">
                <header className="sgz-head">
                    <div className="sgz-title">
                        <h2>{title}</h2>
                        {environment && <span className="sgz-env">{environment}</span>}
                    </div>
                    {!view.dashboard && (
                        <div className="sgz-tabs" role="tablist" aria-label="Signal">
                            {TABS.map((tab) => {
                                const on = view.tab === tab.id && !view.trace;
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={on}
                                        className={`sgz-tab${on ? " on" : ""}`}
                                        onClick={() => updateView(paneId, { tab: tab.id, trace: null })}>
                                        {tab.label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <TimeControls paneId={paneId} />
                </header>
                {view.dashboard ? (
                    <DashboardView dashboardId={view.dashboard} scope={scope} active={active} signozUrl={status.data.url} />
                ) : view.trace ? (
                    <TraceView traceId={view.trace} onBack={() => updateView(paneId, { trace: null })} />
                ) : (
                    <>
                        <FilterBar paneId={paneId} signal={view.tab} />
                        {view.tab === "logs" ? <LogFeed paneId={paneId} active={active} /> : <TraceList paneId={paneId} active={active} />}
                    </>
                )}
            </section>
        </div>
    );
}
