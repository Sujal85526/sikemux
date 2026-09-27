import { useResourceEnabled } from "../../../plugin-api/resources";
import type { RepoRef } from "../api";
import { actionsAnnotationsR } from "../resources";

/** Where an annotation points, written the way an editor jumps to it. */
export function annotationPlace(path: string | null, startLine: number | null): string | null {
    if (!path) return null;
    return startLine ? `${path}:${startLine}` : path;
}

interface Props {
    repo: RepoRef;
    checkRunId: number;
    active: boolean;
}

/**
 * What GitHub flagged in a job, which is the answer to "why did this fail"
 * without reading the log.
 */
export function Annotations({ repo, checkRunId, active }: Props) {
    const found = useResourceEnabled(active, actionsAnnotationsR, repo, checkRunId);
    const annotations = found.data ?? [];
    if (annotations.length === 0) return null;

    return (
        <div className="gha-annotations">
            {annotations.map((annotation, index) => {
                const place = annotationPlace(annotation.path, annotation.startLine);
                return (
                    <div className="gha-annotation" key={`${annotation.path}-${annotation.startLine}-${index}`} data-level={annotation.level}>
                        <span className="gha-annotation-level">{annotation.level}</span>
                        <div className="gha-annotation-body">
                            {annotation.title && <span className="gha-annotation-title">{annotation.title}</span>}
                            <span className="gha-annotation-message">{annotation.message}</span>
                            {place && <span className="gha-annotation-place gha-mono">{place}</span>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
