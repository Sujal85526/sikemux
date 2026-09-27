import { useResourceEnabled } from "../../../plugin-api/resources";
import { SkeletonRows, VirtualLogList } from "../../../plugin-api/ui";
import type { RepoRef } from "../api";
import { actionsWorkflowFileR } from "../resources";

interface Props {
    repo: RepoRef;
    workflowId: number;
    active: boolean;
}

/** The YAML a run came from, read only, and only once somebody asks for it. */
export function WorkflowFile({ repo, workflowId, active }: Props) {
    const file = useResourceEnabled(active, actionsWorkflowFileR, repo, workflowId);
    const lines = file.data?.text.split("\n") ?? [];

    return (
        <div className="gha-workflow-file">
            {file.status === "loading" && !file.data && <SkeletonRows rows={6} label="Loading the workflow file" />}
            {file.data && (
                <>
                    <div className="gha-section-label gha-mono">{file.data.path}</div>
                    <VirtualLogList
                        items={lines}
                        className="gha-patch gha-mono"
                        rowClassName="gha-patch-line ctx"
                        estimateSize={18}
                        getItemKey={(_, index) => index}
                        renderRow={(line) => line || " "}
                    />
                </>
            )}
        </div>
    );
}
