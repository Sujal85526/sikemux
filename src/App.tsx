import { TerminalPane } from "./terminal/TerminalPane";

// Milestone 1, slice 1: a single full-window terminal pane wired end-to-end
// (Rust PTY -> binary Channel -> Xterm.js WebGL). The window/pane layout,
// status bar and sesh picker build on top of this.
export default function App() {
  return (
    <div className="app">
      <TerminalPane />
    </div>
  );
}
