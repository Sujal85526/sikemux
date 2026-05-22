import type { ReactNode } from "react";
import type { Session, SessionKind } from "../state/types";
import { useWorkspace } from "../state/workspace";
import {
  IconClose,
  IconCommand,
  IconFolder,
  IconPin,
  IconPlus,
  WindowIcon,
} from "./Icons";

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

function kindIcon(kind: SessionKind): ReactNode {
  if (kind === "project") return <IconFolder size={13} />;
  return <IconCommand size={13} />;
}

export function SideRail() {
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const recent = useWorkspace((s) => s.recent);
  const selectSession = useWorkspace((s) => s.selectSession);
  const selectWindowId = useWorkspace((s) => s.selectWindowId);
  const openPicker = useWorkspace((s) => s.openPicker);
  const togglePin = useWorkspace((s) => s.togglePin);
  const closeSession = useWorkspace((s) => s.closeSession);
  const reopenRecent = useWorkspace((s) => s.reopenRecent);

  const pinned = sessions.filter((s) => s.pinned);
  const projects = sessions.filter((s) => !s.pinned && s.kind === "project");
  const commands = sessions.filter((s) => !s.pinned && s.kind === "command");

  const Row = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    return (
      <div>
        <button
          className={`sess-row${active ? " active" : ""}`}
          onClick={() => selectSession(s.id)}
        >
          <span className={`sess-icon ${s.kind}`}>{kindIcon(s.kind)}</span>
          <span className="sess-name">{s.name}</span>
          <span
            className={`sess-pin${s.pinned ? " on" : ""}`}
            title={s.pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              togglePin(s.id);
            }}
          >
            <IconPin size={11} filled={s.pinned} />
          </span>
          <span
            className="sess-close"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation();
              closeSession(s.id);
            }}
          >
            <IconClose size={11} />
          </span>
        </button>
        {active && s.kind === "project" && (
          <div className="win-list">
            {s.windows.map((w, i) => (
              <button
                key={w.id}
                className={`win-row${w.id === s.activeWindowId ? " active" : ""}`}
                onClick={() => selectWindowId(w.id)}
              >
                <span className="win-rail">
                  <span className="win-tick" />
                </span>
                <span className="win-icon">
                  <WindowIcon name={w.name} size={13} />
                </span>
                <span className="win-name">{w.name}</span>
                <span className="win-index">{i + 1}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const Group = ({ label, list }: { label: string; list: Session[] }) =>
    list.length === 0 ? null : (
      <div className="rail-group">
        <div className="rail-group-label">{label}</div>
        {list.map((s) => (
          <Row key={s.id} s={s} />
        ))}
      </div>
    );

  return (
    <aside className="side-rail">
      <div className="rail-head">
        <span className="rail-label">Sessions</span>
        <button className="rail-add" onClick={openPicker} title="Open — M-s">
          <IconPlus size={13} />
        </button>
      </div>

      <div className="rail-scroll">
        <Group label="Superpin" list={pinned} />
        <Group label="Projects" list={projects} />
        <Group label="Command" list={commands} />

        {recent.length > 0 && (
          <div className="rail-group">
            <div className="rail-group-label">Recent</div>
            {recent.map((r) => (
              <button
                key={`${r.kind}:${r.cwd}:${r.name}`}
                className="recent-row"
                onClick={() => reopenRecent(r)}
                title={r.cwd}
              >
                <span className={`sess-icon ${r.kind}`}>{kindIcon(r.kind)}</span>
                <span className="sess-name">{r.name}</span>
                <span className="recent-meta">{basename(r.cwd)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="rail-foot" onClick={openPicker}>
        <span className="kbd">M-s</span>
        <span>open or create a session</span>
      </button>
    </aside>
  );
}
