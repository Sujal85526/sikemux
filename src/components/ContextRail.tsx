import { useClock } from "../hooks/useClock";
import { collectPanes } from "../state/layout";
import { ENVS } from "../state/types";
import { useWorkspace } from "../state/workspace";

const time2 = (n: number) => String(n).padStart(2, "0");

const KEYS: [string, string][] = [
  ["M-\\", "split right"],
  ["M--", "split down"],
  ["M-h j k l", "focus pane"],
  ["M-z", "zoom pane"],
  ["M-s", "session picker"],
  ["M-Tab", "cycle session"],
  ["M-i r g c", "jump window"],
];

export function ContextRail() {
  const now = useClock();
  const session = useWorkspace(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)!,
  );
  const home = useWorkspace((s) => s.home);
  const setEnv = useWorkspace((s) => s.setEnv);

  const win = session.windows.find((w) => w.id === session.activeWindowId)!;
  const pane = collectPanes(win.root).find((p) => p.id === win.activePaneId);

  const rawCwd = session.cwd || home;
  const cwd =
    home && rawCwd.startsWith(home) ? `~${rawCwd.slice(home.length)}` : rawCwd;

  const date = now
    .toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .toLowerCase();

  return (
    <aside className="context-rail">
      <div className="rail-head">
        <span className="rail-label">Context</span>
      </div>

      <div className="rail-scroll">
        {session.kind === "project" && (
          <section className="ctx-section">
            <div className="ctx-label">Environment</div>
            <div className="env-pills">
              {ENVS.map((e) => (
                <button
                  key={e}
                  className={`env-pill${session.env === e ? " active" : ""}`}
                  onClick={() => setEnv(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="ctx-section">
          <div className="ctx-label">Pane</div>
          <div className="ctx-row">
            <span className="ctx-k">window</span>
            <span className="ctx-v">{win.name}</span>
          </div>
          <div className="ctx-row">
            <span className="ctx-k">running</span>
            <span className="ctx-v">{pane?.startup ?? "shell"}</span>
          </div>
          <div className="ctx-row">
            <span className="ctx-k">panes</span>
            <span className="ctx-v">{collectPanes(win.root).length}</span>
          </div>
          <div className="ctx-cwd" title={cwd}>
            {cwd || "~"}
          </div>
        </section>

        <section className="ctx-section">
          <div className="ctx-label">Clock</div>
          <div className="ctx-clock">
            {time2(now.getHours())}
            <span className="ctx-colon">:</span>
            {time2(now.getMinutes())}
            <span className="ctx-secs">{time2(now.getSeconds())}</span>
          </div>
          <div className="ctx-date">{date}</div>
        </section>

        <section className="ctx-section">
          <div className="ctx-label">Keys</div>
          <div className="keys-list">
            {KEYS.map(([k, desc]) => (
              <div className="keys-row" key={k}>
                <span className="kbd">{k}</span>
                <span className="keys-desc">{desc}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
