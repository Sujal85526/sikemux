import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { Agent, Divider, Rect, Session, WinTab } from "../state/types";
import { collectPanes, computeLayout, findSplit, MIN_FRAC } from "../state/layout";
import { useWorkspace } from "../state/workspace";
import { TerminalPane } from "../terminal/TerminalPane";
import { EditorPane } from "./EditorPane";
import { GitPane } from "./GitPane";

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const pct = (n: number) => `${n * 100}%`;

// The center stage. Every window and agent of every session stays mounted
// (visibility-toggled) so detached sessions keep running.
export function Workspace() {
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const areaRef = useRef<HTMLDivElement>(null);

  return (
    <div className="window-area" ref={areaRef}>
      {sessions.flatMap((session) => {
        const isActive = session.id === activeSessionId;
        const windowLayers = session.windows.map((win) => (
          <WindowLayer
            key={win.id}
            session={session}
            win={win}
            areaRef={areaRef}
            visible={
              isActive &&
              session.view === "windows" &&
              win.id === session.activeWindowId
            }
          />
        ));
        const agentLayers = session.agents.map((agent) => (
          <AgentLayer
            key={agent.id}
            session={session}
            agent={agent}
            visible={
              isActive &&
              session.view === "agent" &&
              agent.id === session.activeAgentId
            }
          />
        ));
        return [...windowLayers, ...agentLayers];
      })}
    </div>
  );
}

// An agent's terminal — a single full-stage PTY running the agent CLI.
function AgentLayer({
  session,
  agent,
  visible,
}: {
  session: Session;
  agent: Agent;
  visible: boolean;
}) {
  return (
    <div className={`window-layer${visible ? " visible" : ""}`}>
      <div
        className="pane-cell"
        style={{ left: 0, top: 0, width: "100%", height: "100%" }}
      >
        <div className="pane pane-active">
          <TerminalPane
            cwd={session.cwd || undefined}
            startup={agent.startup}
            active={visible}
          />
        </div>
      </div>
    </div>
  );
}

function WindowLayer({
  session,
  win,
  visible,
  areaRef,
}: {
  session: Session;
  win: WinTab;
  visible: boolean;
  areaRef: RefObject<HTMLDivElement | null>;
}) {
  const zoomedPaneId = useWorkspace((s) => s.zoomedPaneId);
  const focusPane = useWorkspace((s) => s.focusPane);
  const { panes, dividers } = useMemo(() => computeLayout(win.root), [win.root]);
  const leaves = useMemo(() => collectPanes(win.root), [win.root]);
  const zoomActive = visible && zoomedPaneId != null;

  return (
    <div className={`window-layer${visible ? " visible" : ""}`}>
      {leaves.map((p) => {
        const isZoomed = zoomedPaneId === p.id;
        const shown = !zoomActive || isZoomed;
        const rect = isZoomed ? FULL : panes.get(p.id)!;
        const isActive = p.id === win.activePaneId;
        return (
          <div
            key={p.id}
            className="pane-cell"
            style={{
              left: pct(rect.x),
              top: pct(rect.y),
              width: pct(rect.w),
              height: pct(rect.h),
              visibility: shown ? undefined : "hidden",
              zIndex: isZoomed ? 2 : 1,
            }}
          >
            <div
              className={`pane${isActive ? " pane-active" : ""}`}
              onMouseDown={() => visible && focusPane(p.id)}
            >
              {p.kind === "editor" ? (
                <EditorPane
                  cwd={p.cwd || session.cwd}
                  active={visible && isActive && shown}
                />
              ) : p.kind === "git" ? (
                <GitPane
                  cwd={p.cwd || session.cwd}
                  active={visible && isActive && shown}
                />
              ) : (
                <TerminalPane
                  cwd={p.cwd || session.cwd || undefined}
                  startup={p.startup}
                  active={visible && isActive && shown}
                />
              )}
            </div>
          </div>
        );
      })}
      {visible &&
        !zoomActive &&
        dividers.map((d) => (
          <DividerHandle
            key={`${d.splitId}:${d.index}`}
            d={d}
            windowId={win.id}
            areaRef={areaRef}
          />
        ))}
    </div>
  );
}

function DividerHandle({
  d,
  windowId,
  areaRef,
}: {
  d: Divider;
  windowId: string;
  areaRef: RefObject<HTMLDivElement | null>;
}) {
  const horizontal = d.dir === "row";

  const style = horizontal
    ? {
        left: pct(d.rect.x + d.at * d.rect.w),
        top: pct(d.rect.y),
        height: pct(d.rect.h),
      }
    : {
        top: pct(d.rect.y + d.at * d.rect.h),
        left: pct(d.rect.x),
        width: pct(d.rect.w),
      };

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const area = areaRef.current;
    if (!area) return;
    const bounds = area.getBoundingClientRect();
    const st = useWorkspace.getState();
    const sess = st.sessions.find((s) => s.id === st.activeSessionId)!;
    const winNode = sess.windows.find((w) => w.id === windowId);
    const split = winNode ? findSplit(winNode.root, d.splitId) : null;
    if (!split) return;

    const startSizes = split.sizes.slice();
    const i = d.index;
    const axisPx = horizontal
      ? bounds.width * d.rect.w
      : bounds.height * d.rect.h;
    const start = horizontal ? e.clientX : e.clientY;
    const setSplitSizes = st.setSplitSizes;

    const move = (ev: PointerEvent) => {
      let df = ((horizontal ? ev.clientX : ev.clientY) - start) / axisPx;
      df = Math.max(
        -(startSizes[i] - MIN_FRAC),
        Math.min(startSizes[i + 1] - MIN_FRAC, df),
      );
      const sizes = startSizes.slice();
      sizes[i] += df;
      sizes[i + 1] -= df;
      setSplitSizes(windowId, d.splitId, sizes);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={`divider divider-${d.dir}`}
      style={style}
      onPointerDown={onPointerDown}
    />
  );
}
