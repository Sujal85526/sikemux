import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "./DiffEditor";
import { FileIcon } from "./FileIcon";
import { IconChevron } from "./Icons";
import { Tooltip } from "./Tooltip";
import { hasUnstaged, isStaged, type GitFile } from "../api/git";
import { basename, joinPath } from "../lib/paths";

export function MergeReview({
    repo,
    files,
    focusPath,
    onOpenFile,
    onSaved,
}: {
    repo: string;
    files: GitFile[];
    focusPath?: string;
    onOpenFile: (abs: string) => void;
    onSaved: () => void;
}) {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const itemRefs = useRef(new Map<string, HTMLDivElement>());
    const pathsKey = files.map((file) => file.path).join("\0");
    const paths = useMemo(() => (pathsKey ? pathsKey.split("\0") : []), [pathsKey]);
    const pathSet = useMemo(() => new Set(paths), [paths]);

    useEffect(() => {
        setCollapsed((current) => {
            const next = new Set([...current].filter((path) => pathSet.has(path)));
            return next.size === current.size ? current : next;
        });
    }, [pathSet]);

    useEffect(() => {
        if (!focusPath || !pathSet.has(focusPath)) return;
        setCollapsed((current) => {
            if (!current.has(focusPath)) return current;
            const next = new Set(current);
            next.delete(focusPath);
            return next;
        });
        window.requestAnimationFrame(() => itemRefs.current.get(focusPath)?.scrollIntoView?.({ block: "start" }));
    }, [focusPath, pathSet]);

    const toggle = (path: string) =>
        setCollapsed((current) => {
            const next = new Set(current);
            next.has(path) ? next.delete(path) : next.add(path);
            return next;
        });

    const expandedCount = paths.filter((path) => !collapsed.has(path)).length;

    return (
        <div className="merge-review">
            <div className="merge-review-toolbar">
                <span className="merge-review-count">
                    {files.length} {files.length === 1 ? "file" : "files"} · {expandedCount} expanded
                </span>
                <button
                    type="button"
                    className="merge-review-action"
                    onClick={() => setCollapsed(new Set())}
                    disabled={expandedCount === files.length}>
                    expand all
                </button>
                <button type="button" className="merge-review-action" onClick={() => setCollapsed(new Set(paths))} disabled={expandedCount === 0}>
                    collapse all
                </button>
            </div>
            <div className="merge-review-list">
                {files.map((file) => {
                    const path = file.path;
                    const open = !collapsed.has(path);
                    const staged = isStaged(file);
                    const unstaged = hasUnstaged(file);
                    return (
                        <div
                            className="acc-item merge-review-item"
                            key={path}
                            ref={(node) => {
                                if (node) itemRefs.current.set(path, node);
                                else itemRefs.current.delete(path);
                            }}>
                            <div className="acc-header merge-file-header">
                                <Tooltip label={open ? "Collapse" : "Expand"}>
                                    <button
                                        type="button"
                                        className="acc-toggle"
                                        onClick={() => toggle(path)}
                                        aria-label={`${open ? "Collapse" : "Expand"} ${path}`}>
                                        <span className={`acc-chev${open ? " open" : ""}`}>
                                            <IconChevron size={11} />
                                        </span>
                                    </button>
                                </Tooltip>
                                <Tooltip label="Open in editor">
                                    <button type="button" className="acc-name" onClick={() => onOpenFile(joinPath(repo, path))}>
                                        <FileIcon name={basename(path)} size={15} />
                                        <span>{path}</span>
                                    </button>
                                </Tooltip>
                                <span className="merge-file-status">
                                    {staged && <span className="merge-file-badge staged">staged</span>}
                                    {unstaged && <span className="merge-file-badge unstaged">unstaged</span>}
                                </span>
                            </div>
                            {open && <MergeFileDiff repo={repo} file={file} onSaved={onSaved} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function MergeFileDiff({ repo, file, onSaved }: { repo: string; file: GitFile; onSaved: () => void }) {
    const path = file.path;
    const staged = isStaged(file);
    const unstaged = hasUnstaged(file);

    return (
        <div className="merge-review-content">
            {staged && unstaged ? (
                <div className="merge-sections">
                    <div className="merge-section">
                        <div className="merge-section-title staged">staged</div>
                        <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} autoHeight />
                    </div>
                    <div className="merge-section">
                        <div className="merge-section-title unstaged">unstaged</div>
                        <DiffEditor repo={repo} path={path} baseRev=":index" editable onSaved={onSaved} autoHeight />
                    </div>
                </div>
            ) : staged ? (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} autoHeight />
            ) : (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" editable onSaved={onSaved} autoHeight />
            )}
        </div>
    );
}
