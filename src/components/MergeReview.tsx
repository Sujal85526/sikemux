import { DiffEditor } from "./DiffEditor";
import { FileIcon } from "./FileIcon";
import { hasUnstaged, isStaged, type GitFile } from "../api/git";
import { basename } from "../lib/paths";

// VSCode-style review of a single working-tree file: an editable merge view
// (diff vs HEAD inline, Cmd-S saves). The header opens the full file in the
// editor window.
export function MergeReview({
    repo,
    file,
    onOpenFile,
    onSaved,
}: {
    repo: string;
    file: GitFile;
    onOpenFile: (abs: string) => void;
    onSaved: () => void;
}) {
    const path = file.path;
    const staged = isStaged(file);
    const unstaged = hasUnstaged(file);

    return (
        <div className="merge-review">
            <button className="merge-header" onClick={() => onOpenFile(`${repo}/${path}`)} title="Open the full file in the editor">
                <FileIcon name={basename(path)} size={14} />
                <span className="merge-path">{path}</span>
                <span className="merge-open">open in editor →</span>
            </button>
            {staged && unstaged ? (
                <div className="merge-sections">
                    <div className="merge-section">
                        <div className="merge-section-title">staged</div>
                        <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} />
                    </div>
                    <div className="merge-section">
                        <div className="merge-section-title">unstaged</div>
                        <DiffEditor repo={repo} path={path} baseRev=":index" editable onSaved={onSaved} />
                    </div>
                </div>
            ) : staged ? (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} />
            ) : (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" editable onSaved={onSaved} />
            )}
        </div>
    );
}
