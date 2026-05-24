import { DiffEditor } from "./DiffEditor";
import { FileIcon } from "./FileIcon";

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// VSCode-style review of a single working-tree file: an editable merge view
// (diff vs HEAD inline, Cmd-S saves). The header opens the full file in the
// editor window.
export function MergeReview({
  repo,
  path,
  onOpenFile,
  onSaved,
}: {
  repo: string;
  path: string;
  onOpenFile: (abs: string) => void;
  onSaved: () => void;
}) {
  return (
    <div className="merge-review">
      <button
        className="merge-header"
        onClick={() => onOpenFile(`${repo}/${path}`)}
        title="Open the full file in the editor"
      >
        <FileIcon name={basename(path)} size={14} />
        <span className="merge-path">{path}</span>
        <span className="merge-open">open in editor →</span>
      </button>
      <DiffEditor
        repo={repo}
        path={path}
        baseRev="HEAD"
        editable
        onSaved={onSaved}
      />
    </div>
  );
}
