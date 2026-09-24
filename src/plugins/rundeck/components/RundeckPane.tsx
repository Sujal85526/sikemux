import { useMemo } from "react";
import * as cmd from "../state";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { rndStatusR } from "../resources";
import { EmptyState } from "../../../plugin-api/ui";
import { IconWarning } from "../../../plugin-api/ui";
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

export function RundeckPane({ paneId, active }: Props) {
    const view = cmd.useRundeckView(paneId);
    const status = useResourceEnabled(active, rndStatusR);

    const top = useMemo(() => view.stack[view.stack.length - 1] ?? { kind: "matrix" as const }, [view.stack]);

    const body = useMemo(() => {
        if (status.status === "loading" && !status.data) {
            return <RundeckLoading />;
        }
        if (status.data && !status.data.configured) {
            return (
                <RundeckLogin
                    paneId={paneId}
                    initialUrl={status.data.url}
                    initialUser={status.data.user}
                    initialAllowInsecurePrivateHttp={status.data.allow_insecure_private_http}
                    onDone={() => status.refresh()}
                />
            );
        }
        if (status.data && status.data.configured && !status.data.ok && status.data.auth_failed) {
            return (
                <RundeckLogin
                    paneId={paneId}
                    initialUrl={status.data.url}
                    initialUser={status.data.user}
                    initialAllowInsecurePrivateHttp={status.data.allow_insecure_private_http}
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
        <EmptyState
            tone="error"
            icon={<IconWarning size={14} />}
            title="Can't reach Rundeck"
            message={message}
            action={{ label: "Retry", onClick: onRetry }}
        />
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
