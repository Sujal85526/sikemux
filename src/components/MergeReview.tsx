import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DiffEditor } from "./DiffEditor";
import { FileIcon } from "./FileIcon";
import { IconChevron } from "./Icons";
import { Tooltip } from "./Tooltip";
import { hasUnstaged, isStaged, type GitFile } from "../api/git";
import { basename, joinPath } from "../lib/paths";
import { gitFileBadges, gitStatusBadge, type GitStatusBadge } from "./git/gitFileStatus";

const REVIEW_ROW_ESTIMATE = 250;
const REVIEW_DOUBLE_ROW_ESTIMATE = 470;
const REVIEW_HEADER_HEIGHT = 31;

function sameFileList(a: readonly GitFile[], b: readonly GitFile[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].path !== b[i].path || a[i].index !== b[i].index || a[i].worktree !== b[i].worktree) return false;
    }
    return true;
}

/** A git refresh hands us a brand new array even when nothing changed; reuse
 *  the previous one so the diffs below don't remount. */
function useStableFileList(next: GitFile[]): GitFile[] {
    const held = useRef(next);
    if (!sameFileList(held.current, next)) held.current = next;
    return held.current;
}

export function MergeReview({
    repo,
    files: incomingFiles,
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
    const files = useStableFileList(incomingFiles);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const itemRefs = useRef(new Map<string, HTMLDivElement>());
    const listRef = useRef<HTMLDivElement>(null);
    const paths = useMemo(() => files.map((file) => file.path), [files]);
    const pathSet = useMemo(() => new Set(paths), [paths]);
    const pathIndex = useMemo(() => new Map(paths.map((path, index) => [path, index])), [paths]);
    const virtualizer = useVirtualizer({
        count: files.length,
        getScrollElement: () => listRef.current,
        estimateSize: (index) => {
            const file = files[index];
            if (!file || collapsed.has(file.path)) return REVIEW_HEADER_HEIGHT;
            return isStaged(file) && hasUnstaged(file) ? REVIEW_DOUBLE_ROW_ESTIMATE : REVIEW_ROW_ESTIMATE;
        },
        getItemKey: (index) => files[index]?.path ?? index,
        overscan: 2,
        initialRect: { width: 1000, height: 800 },
    });

    useEffect(() => {
        setCollapsed((current) => {
            const next = new Set([...current].filter((path) => pathSet.has(path)));
            return next.size === current.size ? current : next;
        });
    }, [pathSet]);

    useEffect(() => {
        virtualizer.measure();
    }, [collapsed, files, virtualizer]);

    const scrollTargets = useRef({ pathIndex, virtualizer });
    scrollTargets.current = { pathIndex, virtualizer };
    const focusListed = !!focusPath && pathSet.has(focusPath);

    // Only a new focus (or one that has just appeared in the list) scrolls. A
    // status refresh must leave the reader where they were.
    useEffect(() => {
        if (!focusPath || !focusListed) return;
        setCollapsed((current) => {
            if (!current.has(focusPath)) return current;
            const next = new Set(current);
            next.delete(focusPath);
            return next;
        });
        const { pathIndex: index, virtualizer: list } = scrollTargets.current;
        const row = index.get(focusPath) ?? -1;
        window.requestAnimationFrame(() => {
            if (row >= 0) list.scrollToIndex(row, { align: "start" });
            else itemRefs.current.get(focusPath)?.scrollIntoView?.({ block: "start" });
        });
    }, [focusPath, focusListed]);

    const toggle = (path: string) => {
        setCollapsed((current) => {
            const next = new Set(current);
            next.has(path) ? next.delete(path) : next.add(path);
            return next;
        });
    };

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
            <div className="merge-review-list" ref={listRef}>
                <div className="merge-review-virtual" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((row) => {
                        const file = files[row.index];
                        if (!file) return null;
                        const style: CSSProperties = {
                            transform: `translateY(${row.start}px)`,
                            height: row.size,
                            overflow: "clip",
                        };
                        return (
                            <div key={row.key} className="merge-review-virtual-item" style={style}>
                                <div ref={virtualizer.measureElement} data-index={row.index}>
                                    {renderFile(file)}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );

    function renderFile(file: GitFile) {
        const path = file.path;
        const open = !collapsed.has(path);
        const focused = path === focusPath;
        const unstaged = hasUnstaged(file);
        return (
            <div
                className={`acc-item merge-review-item${focused ? " focused" : ""}`}
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
                        {gitFileBadges(file).map((badge) => (
                            <GitStatusSymbol key={badge.source} badge={badge} />
                        ))}
                    </span>
                </div>
                {open && <MergeFileDiff repo={repo} file={file} editable={focused && unstaged} onSaved={onSaved} />}
            </div>
        );
    }
}

function GitStatusSymbol({ badge }: { badge: GitStatusBadge | null }) {
    if (!badge) return null;
    const description = badge.source === badge.label ? badge.label : `${badge.source}: ${badge.label}`;
    return (
        <span className={`git-status-symbol git-${badge.cls}`} title={description} aria-label={description}>
            {badge.letter}
        </span>
    );
}

function MergeFileDiff({ repo, file, editable, onSaved }: { repo: string; file: GitFile; editable: boolean; onSaved: () => void }) {
    const path = file.path;
    const staged = isStaged(file);
    const unstaged = hasUnstaged(file);
    const indexBadge = gitStatusBadge(file.index, "staged");
    const worktreeBadge = gitStatusBadge(file.worktree, "unstaged");

    return (
        <div className="merge-review-content">
            {staged && unstaged ? (
                <div className="merge-sections">
                    <div className="merge-section">
                        <div className="merge-section-title">
                            <GitStatusSymbol badge={indexBadge} />
                            <span>staged</span>
                        </div>
                        <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} autoHeight />
                    </div>
                    <div className="merge-section">
                        <div className="merge-section-title">
                            <GitStatusSymbol badge={worktreeBadge} />
                            <span>unstaged</span>
                        </div>
                        <DiffEditor repo={repo} path={path} baseRev=":index" editable={editable} onSaved={onSaved} autoHeight />
                    </div>
                </div>
            ) : staged ? (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} autoHeight />
            ) : (
                <DiffEditor repo={repo} path={path} baseRev="HEAD" editable={editable} onSaved={onSaved} autoHeight />
            )}
        </div>
    );
}
