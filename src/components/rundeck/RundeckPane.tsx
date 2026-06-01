import { useEffect, useMemo } from "react";
import * as cmd from "../../state/commands";
import { useResourceEnabled } from "../../state/resources";
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

export function RundeckPane({ paneId, active }: Props) {
    const view = useStore((s) => s.rundeckViews[paneId] ?? HOME);
    const status = useResourceEnabled(active, rndStatusR);

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
            return <RundeckLogin paneId={paneId} initialUrl={status.data.url} initialUser={status.data.user} onDone={() => status.refresh()} />;
        }
        if (status.data && status.data.configured && !status.data.ok && status.data.auth_failed) {
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
        if (status.data && status.data.configured && !status.data.ok) {
            return <RundeckStatusError message={status.data.message ?? "Rundeck connection failed"} onRetry={() => status.refresh()} />;
        }
        if (top.kind === "matrix") return <RundeckMatrix paneId={paneId} active={active} />;
        if (top.kind === "service") return <RundeckService paneId={paneId} level={top} active={active} />;
        if (top.kind === "deploy") return <RundeckDeploy paneId={paneId} level={top} active={active} />;
        if (top.kind === "execution") return <RundeckExecution paneId={paneId} level={top} active={active} />;
        return null;
    }, [paneId, status, top, active]);

    const showTree = !!status.data && status.data.configured && status.data.ok;

    return (
        <div className="rnd-pane" data-active={active ? "1" : "0"}>
            <RundeckBreadcrumb paneId={paneId} status={status.data ?? null} />
            <div className="rnd-cols">
                {showTree && <RundeckProjectTree paneId={paneId} active={active} />}
                <div className="rnd-body">{body}</div>
            </div>
        </div>
    );
}

function RundeckStatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="rnd-empty">
            <div className="rnd-empty-msg">couldn't reach Rundeck — {message}</div>
            <button className="rnd-btn-sm" onClick={onRetry}>
                retry
            </button>
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
