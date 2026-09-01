import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "./DiffEditor";
import { FileIcon } from "./FileIcon";
import { IconChevron } from "./Icons";
import { Tooltip } from "./Tooltip";
import { hasUnstaged, isStaged, type GitFile } from "../api/git";
import { basename, joinPath } from "../lib/paths";
import { gitStatusDecoration, type GitStatusDecoration } from "./git/gitFileStatus";

const deferredCallbacks = new Map<Element, (visible: boolean) => void>();
let deferredObserver: IntersectionObserver | null = null;

function canObserveViewport(): boolean {
    return typeof window !== "undefined" && "IntersectionObserver" in window;
}

function observeViewportRange(element: Element, onVisibilityChange: (visible: boolean) => void): () => void {
    deferredObserver ??= new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const callback = deferredCallbacks.get(entry.target);
                callback?.(entry.isIntersecting);
            }
        },
        { rootMargin: "260px 0px" },
    );
    deferredCallbacks.set(element, onVisibilityChange);
    deferredObserver.observe(element);
    return () => {
        deferredObserver?.unobserve(element);
        deferredCallbacks.delete(element);
        releaseObserverIfIdle();
    };
}

function releaseObserverIfIdle(): void {
    if (deferredCallbacks.size > 0) return;
    deferredObserver?.disconnect();
    deferredObserver = null;
}

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
    const directExpansion = useRef<string | null>(null);
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

    useLayoutEffect(() => {
        directExpansion.current = null;
    });

    const toggle = (path: string) => {
        directExpansion.current = collapsed.has(path) ? path : null;
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
                    onClick={() => {
                        directExpansion.current = null;
                        setCollapsed(new Set());
                    }}
                    disabled={expandedCount === files.length}>
                    expand all
                </button>
                <button
                    type="button"
                    className="merge-review-action"
                    onClick={() => {
                        directExpansion.current = null;
                        setCollapsed(new Set(paths));
                    }}
                    disabled={expandedCount === 0}>
                    collapse all
                </button>
            </div>
            <div className="merge-review-list">
                {files.map((file) => {
                    const path = file.path;
                    const open = !collapsed.has(path);
                    const focused = path === focusPath;
                    const unstaged = hasUnstaged(file);
                    const indexStatus = gitStatusDecoration(file.index);
                    const worktreeStatus = gitStatusDecoration(file.worktree);
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
                                    <GitStatusSymbol status={indexStatus} source="Index" />
                                    <GitStatusSymbol status={worktreeStatus} source="Working tree" />
                                </span>
                            </div>
                            {open && (
                                <DeferredMergeFileDiff
                                    repo={repo}
                                    file={file}
                                    editable={focused && unstaged}
                                    priority={focused || directExpansion.current === path}
                                    onSaved={onSaved}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function GitStatusSymbol({ status, source }: { status: GitStatusDecoration | null; source: string }) {
    if (!status) return null;
    return (
        <span
            className={`git-status-symbol git-${status.cls}`}
            title={`${source}: ${status.label}`}
            aria-label={`${source} status: ${status.letter}`}>
            {status.letter}
        </span>
    );
}

function DeferredMergeFileDiff({
    repo,
    file,
    editable,
    priority,
    onSaved,
}: {
    repo: string;
    file: GitFile;
    editable: boolean;
    priority: boolean;
    onSaved: () => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = useState(() => priority || !canObserveViewport());
    const [placeholderHeight, setPlaceholderHeight] = useState(220);

    useEffect(() => {
        if (priority) {
            setMounted(true);
            return;
        }
        if (!canObserveViewport()) {
            setMounted(true);
            return;
        }
        const host = hostRef.current;
        if (!host) return;
        return observeViewportRange(host, (visible) => {
            if (visible) {
                setMounted(true);
                return;
            }
            const measuredHeight = host.getBoundingClientRect().height;
            if (measuredHeight > 0) setPlaceholderHeight(Math.ceil(measuredHeight));
            setMounted(false);
        });
    }, [priority]);

    return (
        <div ref={hostRef} className="merge-review-deferred">
            {mounted ? (
                <MergeFileDiff repo={repo} file={file} editable={editable} onSaved={onSaved} />
            ) : (
                <div
                    className="merge-review-placeholder"
                    style={{ height: placeholderHeight }}
                    aria-label={`Diff for ${file.path} loads when scrolled near`}
                />
            )}
        </div>
    );
}

function MergeFileDiff({ repo, file, editable, onSaved }: { repo: string; file: GitFile; editable: boolean; onSaved: () => void }) {
    const path = file.path;
    const staged = isStaged(file);
    const unstaged = hasUnstaged(file);
    const indexStatus = gitStatusDecoration(file.index);
    const worktreeStatus = gitStatusDecoration(file.worktree);

    return (
        <div className="merge-review-content">
            {staged && unstaged ? (
                <div className="merge-sections">
                    <div className="merge-section">
                        <div className="merge-section-title">
                            <GitStatusSymbol status={indexStatus} source="Index" />
                        </div>
                        <DiffEditor repo={repo} path={path} baseRev="HEAD" headRev=":index" editable={false} autoHeight />
                    </div>
                    <div className="merge-section">
                        <div className="merge-section-title">
                            <GitStatusSymbol status={worktreeStatus} source="Working tree" />
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
