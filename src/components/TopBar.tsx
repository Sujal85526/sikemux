import { useState } from "react";
import { useClock } from "../hooks/useClock";
import { ENVS } from "../state/types";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { awsIdentityR } from "../state/resources.defs";
import { useStore } from "../state/store";
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

// Always-visible AWS status chip. Click → opens (or focuses) the AWS
// session; if the profile is expired, opens the sign-in modal instead.
// The shared awsIdentityR resource refetches every 60s — both this chip
// and the AwsPane subscribe to the same cache entry.
function AwsChip() {
  const profile = useStore((s) => s.awsProfile);
  const identity = useResource(awsIdentityR, profile ?? "", false);
  const status = profile ? identity.data?.status : undefined;

  const dotClass =
    status === "authed"
      ? "ok"
      : identity.status === "loading"
        ? "checking"
        : status === "expired" || status === "no-credentials"
          ? "fail"
          : !profile
            ? "off"
            : "warn";

  const onClick = () => {
    if (!profile) {
      cmd.openAwsSession();
      return;
    }
    if (status === "expired" || status === "no-credentials") {
      cmd.openAwsAuthModal(profile, null);
      return;
    }
    cmd.openAwsSession();
  };

  return (
    <button className="tb-aws-chip" onClick={onClick} title="AWS">
      <CloudIcon size={14} />
      <span className="tb-aws-label">
        {profile ? profile.slice(0, 18) : "aws"}
      </span>
      <span className={`tb-aws-dot ${dotClass}`} />
    </button>
  );
}

function CloudIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M19 18H6a4 4 0 0 1-.7-7.94 6 6 0 0 1 11.43-1.39A4.5 4.5 0 0 1 19 18z" />
    </svg>
  );
}

function CogIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function TopBar() {
  const now = useClock();
  const session = useStore((s) => s.sessions[s.activeSessionId]);
  const win = useStore((s) =>
    session ? s.windows[session.activeWindowId] : undefined,
  );
  const agent = useStore((s) =>
    session?.activeAgentId ? s.agents[session.activeAgentId] : undefined,
  );
  const zoomed = useStore((s) => s.zoomedPaneId != null);
  const leftOpen = useStore((s) => s.leftRailOpen);
  const rightOpen = useStore((s) => s.rightRailOpen);
  const [envOpen, setEnvOpen] = useState(false);

  if (!session || !win) return null;
  const isProject = session.kind === "project";

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
            {isProject ? <IconFolder size={12} /> : <IconCommand size={12} />}
          </span>
          <span className="crumb-session">{session.name}</span>
          {isProject && (
            <>
              <IconChevron size={11} className="crumb-sep" />
              <span className="crumb-win">
                {session.view === "agent" ? (
                  agent?.title ?? "agent"
                ) : (
                  <>
                    <WindowIcon role={win.role} size={12} />
                    {win.name}
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="tb-right">
        {zoomed && (
          <span className="zoom-pill">
            <IconZoom size={11} />
            zoom
          </span>
        )}
        {isProject && (
          <div className="env-dd">
            <button className="env-dd-btn" onClick={() => setEnvOpen((v) => !v)}>
              <span className={`env-dot ${session.env}`} />
              {session.env}
              <IconChevron size={10} className="env-dd-chev" />
            </button>
            {envOpen && (
              <>
                <div className="env-dd-scrim" onClick={() => setEnvOpen(false)} />
                <div className="env-dd-menu">
                  {ENVS.map((e) => (
                    <button
                      key={e}
                      className={`env-dd-item${session.env === e ? " active" : ""}`}
                      onClick={() => {
                        cmd.setEnv(e);
                        setEnvOpen(false);
                      }}
                    >
                      <span className={`env-dot ${e}`} />
                      {e}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <AwsChip />
        <span className="tb-clock">
          {time2(now.getHours())}
          <span className="tb-colon">:</span>
          {time2(now.getMinutes())}
        </span>
        <div className="tb-toggles">
          <button
            className={`tb-btn${leftOpen ? " on" : ""}`}
            onClick={cmd.toggleLeftRail}
            title="Toggle sessions rail"
          >
            <IconPanelLeft size={15} />
          </button>
          <button
            className={`tb-btn${rightOpen ? " on" : ""}`}
            onClick={cmd.toggleRightRail}
            title="Toggle agents rail"
          >
            <IconPanelRight size={15} />
          </button>
          <button
            className="tb-btn"
            onClick={cmd.toggleSettings}
            title="Settings (⌘,)"
          >
            <CogIcon size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
