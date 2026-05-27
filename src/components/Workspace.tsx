import { memo, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type {
  Agent,
  Divider,
  Rect,
  Session,
  Window as WindowT,
} from "../state/types";
import { collectPanes, computeLayout, findSplit, MIN_FRAC } from "../state/layout";
import * as cmd from "../state/commands";
import { getState, useStore } from "../state/store";
import { TerminalPane } from "../terminal/TerminalPane";
import { EditorPane } from "./EditorPane";
import { GitPane } from "./GitPane";
import { AwsPane } from "./aws/AwsPane";
import { RundeckPane } from "./rundeck/RundeckPane";
import { SearchPane } from "./SearchPane";
import {
  AgentIcon,
  IconClose,
  IconCommand,
  IconShield,
  IconShieldBolt,
} from "./Icons";

const AGENT_TABS_H = 32;
const TERM_TABS_H = 32;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const pct = (n: number) => `${n * 100}%`;

// The center stage. Every window and agent of every session stays mounted
// (visibility-toggled) so detached sessions keep running.
export function Workspace() {
  const sessionsById = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const windowsById = useStore((s) => s.windows);
  const agentsById = useStore((s) => s.agents);
  const windowsBySession = useStore((s) => s.windowsBySession);
  const agentsBySession = useStore((s) => s.agentsBySession);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const areaRef = useRef<HTMLDivElement>(null);

  const sessions = sessionOrder.map((id) => sessionsById[id]);
  const activeSession = sessionsById[activeSessionId];
  const activeWindow = activeSession
    ? windowsById[activeSession.activeWindowId]
    : undefined;
  const activeAgents = activeSession
    ? (agentsBySession[activeSession.id] ?? []).map((id) => agentsById[id])
    : [];

  const inAgentView = !!activeSession && activeSession.view === "agent";
  const showAgentTabs = inAgentView && activeAgents.length >= 1;
  const showAgentEmpty = inAgentView && activeAgents.length === 0;

  // Term tabs only render when (a) we're in windows view, (b) the active
  // window IS a term tab, and (c) there's at least one — a single tab is
  // visual noise without value (but we still keep the bar for layout sync).
  const activeWindowList = activeSession
    ? (windowsBySession[activeSession.id] ?? []).map((id) => windowsById[id])
    : [];
  const termTabs =
    activeSession?.view === "windows" && activeWindow?.role === "term"
      ? activeWindowList.filter((w) => w.role === "term")
      : [];
  const showTermTabs = termTabs.length >= 1;

  return (
    <div className="window-area" ref={areaRef}>
      {showAgentTabs && (
        <AgentTabsBar session={activeSession!} agents={activeAgents} />
      )}
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
        const winIds = windowsBySession[session.id] ?? [];
        const aIds = agentsBySession[session.id] ?? [];
        const sessTabs =
          session.view === "agent" && aIds.length >= 1;
        const sessHasTermTabs = winIds.some(
          (id) => windowsById[id]?.role === "term",
        );
        const windowLayers = winIds.map((wid) => {
          const win = windowsById[wid];
          if (!win) return null;
          const layerTermTab = win.role === "term";
          const inset =
            isActive &&
            session.view === "windows" &&
            wid === session.activeWindowId &&
            layerTermTab &&
            sessHasTermTabs;
          return (
            <WindowLayer
              key={wid}
              session={session}
              win={win}
              areaRef={areaRef}
              sessionActive={isActive}
              topInset={inset ? TERM_TABS_H : 0}
              visible={
                isActive &&
                session.view === "windows" &&
                wid === session.activeWindowId
              }
            />
          );
        });
        const agentLayers = aIds.map((aid) => {
          const agent = agentsById[aid];
          if (!agent) return null;
          // Include skipPermissions in the React key so toggling it
          // forces React to unmount + remount the AgentLayer (and the
          // TerminalPane inside it). The new PTY then spawns with the
          // updated startup string (with or without the bypass flag).
          // Without this, TerminalPane would keep the old PTY since it
          // captures `startup` at mount time and never re-reads it.
          const key = `${aid}:${agent.skipPermissions ? "skip" : "safe"}`;
          return (
            <AgentLayer
              key={key}
              session={session}
              agent={agent}
              tabsShown={sessTabs}
              sessionActive={isActive}
              visible={
                isActive &&
                session.view === "agent" &&
                aid === session.activeAgentId
              }
            />
          );
        });
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
  tabs: WindowT[];
}) {
  return (
    <div className="agent-tabs" style={{ height: TERM_TABS_H }}>
      {tabs.map((w) => {
        const active = w.id === session.activeWindowId;
        return (
          <button
            key={w.id}
            className={`agent-tab${active ? " active" : ""}`}
            onClick={() => cmd.selectWindowId(w.id)}
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
                  cmd.selectWindowId(w.id);
                  cmd.closeActiveWindow();
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

function AgentTabsBar({
  session,
  agents,
}: {
  session: Session;
  agents: Agent[];
}) {
  return (
    <div className="agent-tabs" style={{ height: AGENT_TABS_H }}>
      {agents.map((a) => {
        const active = a.id === session.activeAgentId;
        const skip = a.skipPermissions ?? false;
        return (
          <button
            key={a.id}
            className={`agent-tab${active ? " active" : ""}`}
            onClick={() => cmd.selectAgent(a.id)}
          >
            <span className={`agent-glyph ${a.type}`}>
              <AgentIcon type={a.type} size={14} />
            </span>
            <span className="agent-tab-title">{a.title}</span>
            <span
              className={`agent-tab-skip${skip ? " on" : ""}`}
              title={
                skip
                  ? `Bypass mode ON (${a.type} runs without approvals). Click to restart safely.`
                  : `Bypass approvals — restarts ${a.type} with its skip-permissions flag.`
              }
              onClick={(e) => {
                e.stopPropagation();
                cmd.toggleAgentSkipPermissions(a.id);
              }}
            >
              {skip ? <IconShieldBolt size={12} /> : <IconShield size={12} />}
            </span>
            <span
              className="agent-tab-x"
              title="Close agent"
              onClick={(e) => {
                e.stopPropagation();
                cmd.closeAgent(a.id);
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
// Memo'd so an unrelated store update doesn't re-render every agent of
// every project. All props are shallow-equal friendly (stable refs from
// the store + primitives).
const AgentLayer = memo(function AgentLayer({
  session,
  agent,
  visible,
  tabsShown,
  sessionActive,
}: {
  session: Session;
  agent: Agent;
  visible: boolean;
  tabsShown: boolean;
  sessionActive: boolean;
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
            sessionActive={sessionActive}
          />
        </div>
      </div>
    </div>
  );
});

// Memo'd at the layer boundary — the largest single perf win for users
// with many projects open. Without this, every store update (fs events,
// AWS chip refreshes, anything) re-runs WindowLayer for every window of
// every session — O(projects × windows) work per mutation. With memo,
// only the two layers whose `visible` actually flipped re-render on a
// window switch.
const WindowLayer = memo(function WindowLayer({
  session,
  win,
  visible,
  areaRef,
  topInset = 0,
  sessionActive,
}: {
  session: Session;
  win: WindowT;
  visible: boolean;
  areaRef: RefObject<HTMLDivElement | null>;
  topInset?: number;
  sessionActive: boolean;
}) {
  const zoomedPaneId = useStore((s) => s.zoomedPaneId);
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
              onMouseDown={() => visible && cmd.focusPane(p.id)}
            >
              {p.kind === "editor" ? (
                <EditorPane
                  paneId={p.id}
                  cwd={p.cwd || session.cwd}
                  active={visible && isActive && shown}
                />
              ) : p.kind === "git" ? (
                <GitPane
                  paneId={p.id}
                  cwd={p.cwd || session.cwd}
                  active={visible && isActive && shown}
                />
              ) : p.kind === "aws" ? (
                <AwsPane />
              ) : p.kind === "rundeck" ? (
                <RundeckPane paneId={p.id} active={visible && isActive && shown} />
              ) : p.kind === "search" ? (
                <SearchPane
                  cwd={p.cwd || session.cwd}
                  active={visible && isActive && shown}
                />
              ) : (
                <TerminalPane
                  cwd={p.cwd || session.cwd || undefined}
                  startup={p.startup}
                  active={visible && isActive && shown}
                  sessionActive={sessionActive}
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
});

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
    const st = getState();
    const winNode = st.windows[windowId];
    const split = winNode ? findSplit(winNode.root, d.splitId) : null;
    if (!split) return;

    const startSizes = split.sizes.slice();
    const i = d.index;
    const axisPx = horizontal
      ? bounds.width * d.rect.w
      : bounds.height * d.rect.h;
    const start = horizontal ? e.clientX : e.clientY;

    const move = (ev: PointerEvent) => {
      let df = ((horizontal ? ev.clientX : ev.clientY) - start) / axisPx;
      df = Math.max(
        -(startSizes[i] - MIN_FRAC),
        Math.min(startSizes[i + 1] - MIN_FRAC, df),
      );
      const sizes = startSizes.slice();
      sizes[i] += df;
      sizes[i + 1] -= df;
      cmd.setSplitSizes(windowId, d.splitId, sizes);
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
