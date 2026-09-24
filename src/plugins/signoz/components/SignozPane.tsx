import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { reportError } from "../../../plugin-api/host";
import { EmptyState, SkeletonRows } from "../../../plugin-api/ui";
import { signozApi, type ServiceHealth } from "../api";
import { signozServicesR, signozStatusR } from "../resources";
import { WINDOWS, setWindow, signozSettings, updateView, useExploreView } from "../state";
import { LogFeed } from "./LogFeed";
import { SignozSignIn } from "./SignozSignIn";
import { TraceView, formatMs } from "./TraceView";

const refreshAll = () => invalidate((kind) => kind.startsWith("signoz."));

function windowLabel(minutes: number): string {
    return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

function ServiceStrip({ paneId, active }: { paneId: string; active: boolean }) {
    const minutes = signozSettings.useSelect((settings) => settings.minutes);
    const selected = useExploreView(paneId).service;
    const services = useResourceEnabled(active, signozServicesR, minutes);
    const pick = (service: ServiceHealth) => updateView(paneId, { service: selected === service.service ? null : service.service, trace: null });
    return (
        <div className="sgz-services" role="listbox" aria-label="Services">
            {services.status === "loading" && !services.data && <span className="sgz-muted">reading services…</span>}
            {services.data?.length === 0 && <span className="sgz-muted">no traced services in the last {windowLabel(minutes)}</span>}
            {services.data?.map((service) => (
                <button
                    key={service.service}
                    type="button"
                    role="option"
                    aria-selected={selected === service.service}
                    className={`sgz-service${selected === service.service ? " selected" : ""}`}
                    onClick={() => pick(service)}
                    title={`${service.calls} calls, ${service.errors} errors, p99 ${formatMs(service.p99Ms)}`}>
                    <span className="sgz-service-name">{service.service}</span>
                    <span className={`sgz-service-errors${service.errors > 0 ? " bad" : ""}`}>
                        {(service.errorRate * 100).toFixed(service.errorRate >= 0.1 ? 0 : 1)}%
                    </span>
                    <span className="sgz-service-p99">{formatMs(service.p99Ms)}</span>
                </button>
            ))}
        </div>
    );
}

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
        <div className="sgz-pane">
            <header className="sgz-bar">
                <ServiceStrip paneId={paneId} active={active} />
                <div className="sgz-bar-end">
                    <select
                        className="sgz-input sgz-window"
                        value={minutes}
                        onChange={(event) => setWindow(Number(event.target.value))}
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
                <LogFeed paneId={paneId} active={active} />
            )}
        </div>
    );
}
