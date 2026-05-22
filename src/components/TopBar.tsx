import { useClock } from "../hooks/useClock";
import { useWorkspace } from "../state/workspace";
import {
  IconChevron,
  IconCommand,
  IconFolder,
  IconPanelLeft,
  IconPanelRight,
  IconZoom,
  Logo,
  WindowIcon,
} from "./Icons";

const time2 = (n: number) => String(n).padStart(2, "0");

export function TopBar() {
  const now = useClock();
  const session = useWorkspace(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)!,
  );
  const zoomed = useWorkspace((s) => s.zoomedPaneId != null);
  const leftOpen = useWorkspace((s) => s.leftRailOpen);
  const rightOpen = useWorkspace((s) => s.rightRailOpen);
  const toggleLeft = useWorkspace((s) => s.toggleLeftRail);
  const toggleRight = useWorkspace((s) => s.toggleRightRail);

  const win = session.windows.find((w) => w.id === session.activeWindowId)!;

  return (
    <header className="top-bar" data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <span className="brand-mark">
          <Logo size={17} />
        </span>
        <span className="brand-name">
          sike<span className="brand-dim">mux</span>
        </span>
      </div>

      <div className="tb-center" data-tauri-drag-region>
        <div className="crumb">
          <span className="crumb-kind">
            {session.kind === "project" ? (
              <IconFolder size={12} />
            ) : (
              <IconCommand size={12} />
            )}
          </span>
          <span className="crumb-session">{session.name}</span>
          <IconChevron size={11} className="crumb-sep" />
          <span className="crumb-win">
            <WindowIcon name={win.name} size={12} />
            {win.name}
          </span>
        </div>
      </div>

      <div className="tb-right">
        {zoomed && (
          <span className="zoom-pill">
            <IconZoom size={11} />
            zoom
          </span>
        )}
        <span className="tb-clock">
          {time2(now.getHours())}
          <span className="tb-colon">:</span>
          {time2(now.getMinutes())}
        </span>
        <div className="tb-toggles">
          <button
            className={`tb-btn${leftOpen ? " on" : ""}`}
            onClick={toggleLeft}
            title="Toggle sessions rail"
          >
            <IconPanelLeft size={15} />
          </button>
          <button
            className={`tb-btn${rightOpen ? " on" : ""}`}
            onClick={toggleRight}
            title="Toggle context rail"
          >
            <IconPanelRight size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
