import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installDiagnostics } from "./lib/diagnostics";
import "./styles.css";

installDiagnostics();
ReactDOM.createRoot(document.getElementById("root")!).render(
    <ErrorBoundary label="Sikemux">
        <App />
    </ErrorBoundary>,
);
