import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { reportError } from "../../../plugin-api/host";
import { EmptyState, SkeletonRows, Switch } from "../../../plugin-api/ui";
import { signozApi } from "../api";
import { signozStatusR } from "../resources";
import { WINDOWS, setLive, signozSettings, updateSettings, updateView, useExploreView, type ExploreTab } from "../state";
import { FilterBar } from "./FilterBar";
import { LogFeed } from "./LogFeed";
import { ServiceSidebar } from "./ServiceSidebar";
import { SignozSignIn } from "./SignozSignIn";
import { TraceList } from "./TraceList";
import { TraceView } from "./TraceView";

const refreshAll = () => invalidate((kind) => kind.startsWith("signoz."));

export function windowLabel(minutes: number): string {
    return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

const TABS: { id: ExploreTab; label: string }[] = [
    { id: "logs", label: "Logs" },
    { id: "traces", label: "Traces" },
];

export function SignozPane({ paneId, active }: { paneId: string; active: boolean }) {
    const status = useResourceEnabled(active, signozStatusR);
    const view = useExploreView(paneId);
    const minutes = signozSettings.useSelect((settings) => settings.minutes);

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

    const signOut = () => void signozApi.signOut().then(refreshAll).catch(reportError("sign out of SigNoz"));

    return (
        <div className="sgz-pane sgz-layout">
            <ServiceSidebar paneId={paneId} active={active} />
            <section className="sgz-main">
                <header className="sgz-bar">
                    <div className="sgz-tabs" role="tablist" aria-label="Signal">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                aria-selected={view.tab === tab.id && !view.trace}
                                className={`sgz-tab${view.tab === tab.id && !view.trace ? " on" : ""}`}
                                onClick={() => updateView(paneId, { tab: tab.id, trace: null })}>
                                {tab.label}
                            </button>
                        ))}
                    </div>
                    <div className="sgz-bar-end">
                        <label className="sgz-toggle" title={view.live ? "Following new data" : "Held on the window ending when you paused"}>
                            <Switch checked={view.live} onChange={(live) => setLive(paneId, live)} />
                            live
                        </label>
                        {!view.live && (
                            <button
                                type="button"
                                className="sgz-add-filter"
                                onClick={() => setLive(paneId, false)}
                                title="Move the window to end now">
                                now
                            </button>
                        )}
                        <select
                            className="sgz-input sgz-window"
                            value={minutes}
                            onChange={(event) => updateSettings({ minutes: Number(event.target.value) })}
                            aria-label="Time window">
                            {WINDOWS.map((option) => (
                                <option key={option} value={option}>
                                    last {windowLabel(option)}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="sgz-who"
                            onClick={signOut}
                            title={`Signed in to ${status.data.url}${status.data.email ? ` as ${status.data.email}` : " with an API key"}. Click to sign out.`}>
                            {status.data.email || "API key"}
                        </button>
                    </div>
                </header>
                {view.trace ? (
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
