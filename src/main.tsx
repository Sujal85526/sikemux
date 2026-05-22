import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: it double-invokes effects in dev, which would spawn and then
// tear down a duplicate PTY per terminal pane.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
