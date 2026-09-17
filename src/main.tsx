import { Profiler } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installDiagnostics, reactProfilingEnabled } from "./lib/diagnostics";
import "./styles.css";
import { performanceTelemetry } from "./lib/performance";

installDiagnostics();

const app = <App />;

ReactDOM.createRoot(document.getElementById("root")!).render(
    <ErrorBoundary label="Sikemux">
        {reactProfilingEnabled() ? (
            <Profiler
                id="app"
                onRender={(_id, phase, actualDuration) => {
                    performanceTelemetry.recordLatency("react.commit", actualDuration);
                    performanceTelemetry.setGauge("react.last-commit-ms", actualDuration);
                    performanceTelemetry.incrementCounter(`react.commits.${phase}`);
                }}>
                {app}
            </Profiler>
        ) : (
            app
        )}
    </ErrorBoundary>,
);
