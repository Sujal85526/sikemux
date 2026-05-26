import { useEffect, useMemo } from "react";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndStatusR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import type { RundeckView } from "../../state/types";
import { RundeckBreadcrumb } from "./RundeckBreadcrumb";
import { RundeckLogin } from "./RundeckLogin";
import { RundeckMatrix } from "./RundeckMatrix";
import { RundeckProjectTree } from "./RundeckProjectTree";
import { RundeckService } from "./RundeckService";
import { RundeckDeploy } from "./RundeckDeploy";
import { RundeckExecution } from "./RundeckExecution";

interface Props {
  paneId: string;
  active: boolean;
}

const HOME: RundeckView = { stack: [{ kind: "matrix" }] };

/** Top-level Rundeck pane — view-only switch on the per-pane nav stack. The
 *  pane is intentionally a "full center" surface: no popups, no modals,
 *  everything renders inline so deep navigation is a first-class citizen. */
export function RundeckPane({ paneId, active }: Props) {
  const view = useStore(
    (s) => s.rundeckViews[paneId] ?? HOME,
  );
  const status = useResource(rndStatusR);

  // Auto-clear stack to "matrix" on first mount so an old persisted nav
  // doesn't strand us inside an execution that's long gone.
  useEffect(() => {
    if (!view) cmd.rundeckHome(paneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  const top = view.stack[view.stack.length - 1] ?? { kind: "matrix" as const };

  const body = useMemo(() => {
    if (status.status === "loading" && !status.data) {
      return <RundeckLoading />;
    }
    if (status.data && !status.data.configured) {
      // Even when "not configured", we may still have URL/user on disk
      // (e.g. after a logout that cleared only token+password). Pre-fill
      // so the user just retypes the password.
      return (
        <RundeckLogin
          paneId={paneId}
          initialUrl={status.data.url}
          initialUser={status.data.user}
          onDone={() => status.refresh()}
        />
      );
    }
    if (status.data && status.data.configured && !status.data.ok) {
      // Token rejected — show the login form with a hint.
      return (
        <RundeckLogin
          paneId={paneId}
          initialUrl={status.data.url}
          initialUser={status.data.user}
          notice={status.data.message ?? "Authentication failed"}
          onDone={() => status.refresh()}
        />
      );
    }
    if (top.kind === "matrix") return <RundeckMatrix paneId={paneId} />;
    if (top.kind === "service") return <RundeckService paneId={paneId} level={top} />;
    if (top.kind === "deploy") return <RundeckDeploy paneId={paneId} level={top} />;
    if (top.kind === "execution") return <RundeckExecution paneId={paneId} level={top} />;
    return null;
  }, [paneId, status, top]);

  // The project tree only makes sense once we're past auth — for login
  // / loading states the body owns the whole pane width.
  const showTree =
    !!status.data && status.data.configured && status.data.ok;

  return (
    <div className="rnd-pane" data-active={active ? "1" : "0"}>
      <RundeckBreadcrumb paneId={paneId} status={status.data ?? null} />
      <div className="rnd-cols">
        {showTree && <RundeckProjectTree />}
        <div className="rnd-body">{body}</div>
      </div>
    </div>
  );
}

function RundeckLoading() {
  return (
    <div className="rnd-loading">
      <span className="rnd-spinner" />
      <span>checking rundeck…</span>
    </div>
  );
}
