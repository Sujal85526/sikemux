import type { Session } from "../state/types";
import { useWorkspace } from "../state/workspace";
import { IconCommand, IconFolder, IconPlus, WindowIcon } from "./Icons";

export function SideRail() {
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const selectSession = useWorkspace((s) => s.selectSession);
  const selectWindowId = useWorkspace((s) => s.selectWindowId);
  const openPicker = useWorkspace((s) => s.openPicker);

  const commands = sessions.filter((s) => s.kind === "command");
  const projects = sessions.filter((s) => s.kind === "project");
  let row = 0;

  const Group = ({ label, list }: { label: string; list: Session[] }) => {
    if (list.length === 0) return null;
    return (
      <div className="rail-group">
        <div className="rail-group-label">{label}</div>
        {list.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <div key={s.id}>
              <button
                className={`sess-row${active ? " active" : ""}`}
                style={{ animationDelay: `${row++ * 26}ms` }}
                onClick={() => selectSession(s.id)}
              >
                <span className={`sess-icon ${s.kind}`}>
                  {s.kind === "project" ? (
                    <IconFolder size={13} />
                  ) : (
                    <IconCommand size={13} />
                  )}
                </span>
                <span className="sess-name">{s.name}</span>
                <span className="sess-count">{s.windows.length}</span>
              </button>
              {active && (
                <div className="win-list">
                  {s.windows.map((w, i) => (
                    <button
                      key={w.id}
                      className={`win-row${
                        w.id === s.activeWindowId ? " active" : ""
                      }`}
                      style={{ animationDelay: `${row++ * 26}ms` }}
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
        })}
      </div>
    );
  };

  return (
    <aside className="side-rail">
      <div className="rail-head">
        <span className="rail-label">Sessions</span>
        <button className="rail-add" onClick={openPicker} title="Open session — M-s">
          <IconPlus size={13} />
        </button>
      </div>
      <div className="rail-scroll">
        <Group label="Command" list={commands} />
        <Group label="Project" list={projects} />
      </div>
      <button className="rail-foot" onClick={openPicker}>
        <span className="kbd">M-s</span>
        <span>open a project</span>
      </button>
    </aside>
  );
}
