import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { Agent, Divider, Rect, Session, WinTab } from "../state/types";
import { collectPanes, computeLayout, findSplit, MIN_FRAC } from "../state/layout";
import { useWorkspace } from "../state/workspace";
import { TerminalPane } from "../terminal/TerminalPane";
import { EditorPane } from "./EditorPane";
import { GitPane } from "./GitPane";
import { AwsPane } from "./aws/AwsPane";
import { AgentIcon, IconClose, IconCommand } from "./Icons";

const AGENT_TABS_H = 32;
const TERM_TABS_H = 32;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const pct = (n: number) => `${n * 100}%`;

// A window is a "term tab" if its name is `term` or a bare integer — the
// integers are the auto-numbered tabs Alt+N spawns inside a project. files
// and git stay as their own first-class windows.
export function isTermTab(name: string): boolean {
  return name === "term" || /^\d+$/.test(name);
}

// The center stage. Every window and agent of every session stays mounted
// (visibility-toggled) so detached sessions keep running.
export function Workspace() {
  const sessionsById = useWorkspace((s) => s.sessions);
  const sessionOrder = useWorkspace((s) => s.sessionOrder);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const areaRef = useRef<HTMLDivElement>(null);

  const sessions = sessionOrder.map((id) => sessionsById[id]);
  const activeSession = sessionsById[activeSessionId];
  const inAgentView = !!activeSession && activeSession.view === "agent";
  const showAgentTabs = inAgentView && activeSession!.agents.length >= 1;
  const showAgentEmpty = inAgentView && activeSession!.agents.length === 0;

  // Term tabs only render when (a) we're in windows view, (b) the active
  // window IS a term tab, and (c) there's more than one — a single tab adds
  // visual noise without value.
  const activeWindow =
    activeSession?.windows.find((w) => w.id === activeSession.activeWindowId);
  const termTabs =
    activeSession?.view === "windows" && activeWindow && isTermTab(activeWindow.name)
      ? activeSession.windows.filter((w) => isTermTab(w.name))
      : [];
  const showTermTabs = termTabs.length >= 1;

  return (
    <div className="window-area" ref={areaRef}>
      {showAgentTabs && <AgentTabsBar session={activeSession!} />}
      {showTermTabs && (
        <TerminalTabsBar session={activeSession!} tabs={termTabs} />
      )}
      {showAgentEmpty && (
        <div className="agent-empty-stage">
          <span>no agents in this project</span>
          <span className="agent-empty-hint">
            start one from the agent rail →
          </span>
        </div>
      )}
      {sessions.flatMap((session) => {
        const isActive = session.id === activeSessionId;
        const sessTabs =
          session.view === "agent" && session.agents.length >= 1;
        const windowLayers = session.windows.map((win) => {
          const layerTermTabs = isTermTab(win.name);
          // Inset only when this very session is showing its term tab bar.
          const inset =
            isActive &&
            session.view === "windows" &&
            win.id === session.activeWindowId &&
            layerTermTabs &&
            session.windows.filter((w) => isTermTab(w.name)).length >= 1;
          return (
            <WindowLayer
              key={win.id}
              session={session}
              win={win}
              areaRef={areaRef}
              topInset={inset ? TERM_TABS_H : 0}
              visible={
                isActive &&
                session.view === "windows" &&
                win.id === session.activeWindowId
              }
            />
          );
        });
        const agentLayers = session.agents.map((agent) => (
          <AgentLayer
            key={agent.id}
            session={session}
            agent={agent}
            tabsShown={sessTabs}
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

function TerminalTabsBar({
  session,
  tabs,
}: {
  session: Session;
  tabs: WinTab[];
}) {
  const selectWindowId = useWorkspace((s) => s.selectWindowId);
  const closeActiveWindow = useWorkspace((s) => s.closeActiveWindow);
  return (
    <div className="agent-tabs" style={{ height: TERM_TABS_H }}>
      {tabs.map((w) => {
        const active = w.id === session.activeWindowId;
        return (
          <button
            key={w.id}
            className={`agent-tab${active ? " active" : ""}`}
            onClick={() => selectWindowId(w.id)}
          >
            <span className="agent-glyph">
              <IconCommand size={13} />
            </span>
            <span className="agent-tab-title">{w.name}</span>
            {!w.fixed && (
              <span
                className="agent-tab-x"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  selectWindowId(w.id);
                  closeActiveWindow();
                }}
              >
                <IconClose size={11} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function AgentTabsBar({ session }: { session: Session }) {
  const selectAgent = useWorkspace((s) => s.selectAgent);
  const closeAgent = useWorkspace((s) => s.closeAgent);
  return (
    <div className="agent-tabs" style={{ height: AGENT_TABS_H }}>
      {session.agents.map((a) => {
        const active = a.id === session.activeAgentId;
        return (
          <button
            key={a.id}
            className={`agent-tab${active ? " active" : ""}`}
            onClick={() => selectAgent(a.id)}
          >
            <span className={`agent-glyph ${a.type}`}>
              <AgentIcon type={a.type} size={14} />
            </span>
            <span className="agent-tab-title">{a.title}</span>
            <span
              className="agent-tab-x"
              title="Close agent"
              onClick={(e) => {
                e.stopPropagation();
                closeAgent(a.id);
              }}
            >
              <IconClose size={11} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

// An agent's terminal — a single full-stage PTY running the agent CLI.
// When the session has multiple agents, leaves room at the top for tabs.
function AgentLayer({
  session,
  agent,
  visible,
  tabsShown,
}: {
  session: Session;
  agent: Agent;
  visible: boolean;
  tabsShown: boolean;
}) {
  return (
    <div className={`window-layer${visible ? " visible" : ""}`}>
      <div
        className="pane-cell"
        style={{
          left: 0,
          top: tabsShown ? `${AGENT_TABS_H}px` : 0,
          width: "100%",
          height: tabsShown ? `calc(100% - ${AGENT_TABS_H}px)` : "100%",
        }}
      >
        <div className="pane pane-terminal">
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
  topInset = 0,
}: {
  session: Session;
  win: WinTab;
  visible: boolean;
  areaRef: RefObject<HTMLDivElement | null>;
  topInset?: number;
}) {
  const zoomedPaneId = useWorkspace((s) => s.zoomedPaneId);
  const focusPane = useWorkspace((s) => s.focusPane);
  const { panes, dividers } = useMemo(() => computeLayout(win.root), [win.root]);
  const leaves = useMemo(() => collectPanes(win.root), [win.root]);
  const zoomActive = visible && zoomedPaneId != null;

  return (
    <div
      className={`window-layer${visible ? " visible" : ""}`}
      style={topInset ? { top: `${topInset}px` } : undefined}
    >
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
              className={`pane pane-${p.kind}`}
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
              ) : p.kind === "aws" ? (
                <AwsPane />
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
    const sess = st.sessions[st.activeSessionId];
    const winNode = sess?.windows.find((w) => w.id === windowId);
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
