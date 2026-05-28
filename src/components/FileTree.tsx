import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { fsapi, type DirEntry } from "../api/fs";
import { type GitFile } from "../api/git";
import { subscribe } from "../state/bus";
import { useResourceEnabled } from "../state/resources";
import { gitStatusR } from "../state/resources.defs";
import { reportError, swallow } from "../state/toast";
import { registerFolderDrop } from "../state/dropRegistry";
import { IconChevron, IconFolder, IconPlus } from "./Icons";
import { FileIcon } from "./FileIcon";

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// VSCode-style decoration letter + class for a git-tracked file.
function gitDecoration(f: GitFile): { letter: string; cls: string } {
    if (f.index === "?" || f.worktree === "?") return { letter: "U", cls: "u" };
    if (f.worktree === "D" || f.index === "D") return { letter: "D", cls: "d" };
    if (f.index === "A") return { letter: "A", cls: "a" };
    if (f.index === "R" || f.worktree === "R") return { letter: "R", cls: "r" };
    if (f.worktree === "M" || f.index === "M") return { letter: "M", cls: "m" };
    return { letter: f.worktree.trim() || f.index.trim(), cls: "m" };
}

interface FileTreeProps {
    cwd: string;
    activePath: string | null;
    onOpenFile: (entry: DirEntry) => void;
    width: number;
    onResize: (w: number) => void;
    active: boolean;
    /** When the file tree should auto-reveal a path (e.g. tab switched). */
    revealPath?: string | null;
}

interface NewEntryRequest {
    /** Parent directory the new entry will be created in. */
    parent: string;
    kind: "file" | "folder";
}

export function FileTree({ cwd, activePath, onOpenFile, width, onResize, active, revealPath }: FileTreeProps) {
    const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Row the user clicked last — folder selections decide where "new file"
    // / "new folder" lands. null = root cwd.
    const [selectedDir, setSelectedDir] = useState<string | null>(null);
    // Inline-input render state for "+ new file" / "+ new folder".
    const [newRequest, setNewRequest] = useState<NewEntryRequest | null>(null);
    const [newName, setNewName] = useState("");
    const newInputRef = useRef<HTMLInputElement>(null);
    // Rename-in-place state — { path: original abs path, name: current input }.
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameName, setRenameName] = useState("");
    const renameInputRef = useRef<HTMLInputElement>(null);
    // Highlight folder row currently being drag-hovered.
    const [dragOver, setDragOver] = useState<string | null>(null);

    const expandedRef = useRef(expanded);
    expandedRef.current = expanded;

    const status = useResourceEnabled(active && !!cwd, gitStatusR, cwd || "");
    const gitMap = (() => {
        const m = new Map<string, GitFile>();
        if (cwd && status.data) {
            status.data.files.forEach((f) => m.set(`${cwd}/${f.path}`, f));
        }
        return m;
    })();

    const loadDir = useCallback((path: string) => {
        return fsapi
            .readDir(path)
            .then((e) => {
                setDirs((d) => ({ ...d, [path]: e }));
            })
            .catch(swallow("readDir"));
    }, []);

    // Load root.
    useEffect(() => {
        if (!cwd || !active) return;
        void loadDir(cwd);
    }, [cwd, active, loadDir]);

    // Live watcher: when the backend reports a filesystem change in this
    // repo, re-fetch every open dir (root + every expanded). Cheap — a few
    // readDir calls, indexed off the existing fs-watch we already started
    // for git overview. Same recipe Zed uses: never trust a cached listing
    // once the watcher fires.
    useEffect(() => {
        if (!cwd || !active) return;
        const unsubscribe = subscribe("fs-changed", (e) => {
            if (e.repo && e.repo !== cwd) return;
            void loadDir(cwd);
            for (const p of expandedRef.current) void loadDir(p);
        });
        return unsubscribe;
    }, [cwd, active, loadDir]);

    // Reveal the active file by expanding every ancestor.
    useEffect(() => {
        const path = revealPath ?? activePath;
        if (!active || !path || !cwd || !path.startsWith(`${cwd}/`)) return;
        const rel = path.slice(cwd.length + 1);
        const parts = rel.split("/");
        if (parts.length < 2) return;
        const parents: string[] = [];
        let p = cwd;
        for (let i = 0; i < parts.length - 1; i++) {
            p = `${p}/${parts[i]}`;
            parents.push(p);
        }
        setExpanded((s) => {
            const n = new Set(s);
            parents.forEach((x) => n.add(x));
            return n;
        });
        for (const par of parents) {
            if (!dirs[par]) void loadDir(par);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealPath, activePath, cwd, active]);

    useEffect(() => {
        if (newRequest) newInputRef.current?.focus();
    }, [newRequest]);

    useEffect(() => {
        if (renaming) {
            const el = renameInputRef.current;
            if (el) {
                el.focus();
                // Pre-select the basename (without extension) so a quick rename
                // doesn't blow away the file's extension — VSCode/Finder behavior.
                const dot = el.value.lastIndexOf(".");
                if (dot > 0) el.setSelectionRange(0, dot);
                else el.select();
            }
        }
    }, [renaming]);

    const startRename = (entry: DirEntry) => {
        setRenaming(entry.path);
        setRenameName(entry.name);
    };
    const cancelRename = () => {
        setRenaming(null);
        setRenameName("");
    };
    const submitRename = async () => {
        if (!renaming) return;
        const trimmed = renameName.trim();
        if (!trimmed || trimmed === basename(renaming)) {
            cancelRename();
            return;
        }
        const lastSlash = renaming.lastIndexOf("/");
        const dest = `${renaming.slice(0, lastSlash)}/${trimmed}`;
        try {
            await fsapi.rename(renaming, dest);
            // Refresh the parent dir so the renamed entry shows up. fs-watcher
            // will also re-fire shortly, but that lags 200ms (debounce).
            const parent = renaming.slice(0, lastSlash);
            await loadDir(parent);
            cancelRename();
            // If a file was the active tab, the editor still holds the old path.
            // The fs-changed event will trigger its live-reload effect; the user
            // can re-open via the file tree.
        } catch (err) {
            reportError("rename")(err);
        }
    };

    const toggleDir = async (entry: DirEntry) => {
        setSelectedDir(entry.path);
        const open = expanded.has(entry.path);
        setExpanded((s) => {
            const n = new Set(s);
            open ? n.delete(entry.path) : n.add(entry.path);
            return n;
        });
        if (!open && !dirs[entry.path]) await loadDir(entry.path);
    };

    // ---- new file / folder ----

    const startNew = (kind: "file" | "folder") => {
        // Determine parent: selected dir, or parent dir of active file, or root.
        let parent = selectedDir;
        if (!parent && activePath && activePath.startsWith(`${cwd}/`)) {
            const last = activePath.lastIndexOf("/");
            if (last > cwd.length) parent = activePath.slice(0, last);
        }
        if (!parent) parent = cwd;
        setExpanded((s) => new Set(s).add(parent!));
        if (!dirs[parent]) void loadDir(parent);
        setNewRequest({ parent, kind });
        setNewName("");
    };

    const cancelNew = () => {
        setNewRequest(null);
        setNewName("");
    };

    const submitNew = async () => {
        if (!newRequest) return;
        const name = newName.trim();
        if (!name) {
            cancelNew();
            return;
        }
        const target = `${newRequest.parent}/${name}`;
        try {
            if (newRequest.kind === "file") await fsapi.createFile(target);
            else await fsapi.createDir(target);
            await loadDir(newRequest.parent);
            cancelNew();
            // If a file was created, open it in the editor.
            if (newRequest.kind === "file") {
                onOpenFile({
                    name,
                    path: target,
                    is_dir: false,
                });
            }
        } catch (err) {
            reportError("create")(err);
        }
    };

    // ---- drag-drop into a folder ----

    // Attach the App.tsx-routed drop handler to each folder row via the
    // dropRegistry WeakMap. The global listener in App.tsx hit-tests
    // elementFromPoint and walks up to a `.tree-row.is-folder` ancestor.
    // Per-row refs come+go as the tree expands/collapses; registerFolderDrop
    // returns an unregister fn, and WeakMap cleanup picks up the slack if a
    // node is removed from the DOM without us being notified.
    const folderUnregRef = useRef<Map<HTMLElement, () => void>>(new Map());
    const attachFolderDrop = (el: HTMLButtonElement | null, dir: string) => {
        if (!el) return;
        // Replace any prior registration on this exact node.
        folderUnregRef.current.get(el)?.();
        const unreg = registerFolderDrop(el, async (paths) => {
            try {
                for (const p of paths) await fsapi.copyIntoDir(p, dir);
                await loadDir(dir);
                setExpanded((s) => new Set(s).add(dir));
            } catch (err) {
                reportError("drop")(err);
            }
        });
        folderUnregRef.current.set(el, unreg);
    };
    useEffect(() => {
        const map = folderUnregRef.current;
        return () => {
            for (const u of map.values()) u();
            map.clear();
        };
    }, []);

    const renderTree = (path: string, depth: number): ReactNode => {
        const entries = dirs[path] ?? [];
        const items: ReactNode[] = [];
        for (const e of entries) {
            const pad = 10 + depth * 13;
            if (e.is_dir) {
                const open = expanded.has(e.path);
                const isRenaming = renaming === e.path;
                items.push(
                    <div key={e.path}>
                        {isRenaming ? (
                            <RenameRow
                                depth={depth}
                                kind="folder"
                                value={renameName}
                                inputRef={renameInputRef}
                                onChange={setRenameName}
                                onSubmit={submitRename}
                                onCancel={cancelRename}
                            />
                        ) : (
                            <button
                                ref={(el) => attachFolderDrop(el, e.path)}
                                className={`tree-row is-folder${selectedDir === e.path ? " selected" : ""}${dragOver === e.path ? " drag-over" : ""}`}
                                style={{ paddingLeft: pad }}
                                onClick={() => toggleDir(e)}
                                onDoubleClick={() => startRename(e)}
                                data-folder-path={e.path}>
                                <span className={`tree-chev${open ? " open" : ""}`}>
                                    <IconChevron size={11} />
                                </span>
                                <span className="tree-folder">
                                    <IconFolder size={17} />
                                </span>
                                <span className="tree-name">{e.name}</span>
                            </button>
                        )}
                        {open && renderTree(e.path, depth + 1)}
                        {newRequest?.parent === e.path && (
                            <NewEntryRow
                                depth={depth + 1}
                                kind={newRequest.kind}
                                value={newName}
                                inputRef={newInputRef}
                                onChange={setNewName}
                                onSubmit={submitNew}
                                onCancel={cancelNew}
                            />
                        )}
                    </div>,
                );
            } else {
                const gf = gitMap.get(e.path);
                const gd = gf ? gitDecoration(gf) : null;
                const isRenaming = renaming === e.path;
                if (isRenaming) {
                    items.push(
                        <RenameRow
                            key={e.path}
                            depth={depth + 1}
                            kind="file"
                            value={renameName}
                            inputRef={renameInputRef}
                            onChange={setRenameName}
                            onSubmit={submitRename}
                            onCancel={cancelRename}
                        />,
                    );
                } else {
                    items.push(
                        <button
                            key={e.path}
                            className={`tree-row file${activePath === e.path ? " active" : ""}${gd ? ` git-${gd.cls}` : ""}`}
                            style={{ paddingLeft: pad + 13 }}
                            onClick={() => {
                                setSelectedDir(null);
                                onOpenFile(e);
                            }}
                            onDoubleClick={() => startRename(e)}>
                            <span className="tree-file">
                                <FileIcon name={e.name} size={20} />
                            </span>
                            <span className="tree-name">{e.name}</span>
                            {gd && <span className="tree-git">{gd.letter}</span>}
                        </button>,
                    );
                }
            }
        }
        return items;
    };

    const onResizeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        let latest = startW;
        const move = (ev: PointerEvent) => {
            latest = Math.min(600, Math.max(160, startW + ev.clientX - startX));
            onResize(latest);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    // Root-level drop target: drops outside any folder land in cwd.
    const rootScrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = rootScrollRef.current;
        if (!el || !cwd || !active) return;
        return registerFolderDrop(el, async (paths) => {
            try {
                for (const p of paths) await fsapi.copyIntoDir(p, cwd);
                await loadDir(cwd);
            } catch (err) {
                reportError("drop")(err);
            }
        });
    }, [cwd, active, loadDir]);

    const handleDragOver = (e: React.DragEvent) => {
        // Prevent the webview's default navigate-to-file://. Tauri's drop
        // event hands us absolute paths via the listener in App.tsx.
        e.preventDefault();
        const t = (e.target as HTMLElement | null)?.closest(".tree-row.is-folder") as HTMLElement | null;
        setDragOver(t?.dataset.folderPath ?? null);
    };
    const handleDragLeave = () => setDragOver(null);
    const handleDrop = () => setDragOver(null);

    return (
        <>
            <div className="ed-tree" style={{ width }}>
                <div className="ed-tree-head">
                    <span className="ed-tree-name">{basename(cwd) || "files"}</span>
                    <span className="ed-tree-actions">
                        <button type="button" className="ed-tree-act" title="New file (a)" onClick={() => startNew("file")}>
                            <FileIcon name="" size={13} />
                            <IconPlus size={9} />
                        </button>
                        <button type="button" className="ed-tree-act" title="New folder (A)" onClick={() => startNew("folder")}>
                            <IconFolder size={13} />
                            <IconPlus size={9} />
                        </button>
                    </span>
                </div>
                <div ref={rootScrollRef} className="ed-tree-scroll" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                    {renderTree(cwd, 0)}
                    {newRequest?.parent === cwd && (
                        <NewEntryRow
                            depth={0}
                            kind={newRequest.kind}
                            value={newName}
                            inputRef={newInputRef}
                            onChange={setNewName}
                            onSubmit={submitNew}
                            onCancel={cancelNew}
                        />
                    )}
                </div>
            </div>
            <div className="ed-tree-resizer" onPointerDown={onResizeDrag} title="Drag to resize" />
        </>
    );
}

function NewEntryRow({
    depth,
    kind,
    value,
    onChange,
    onSubmit,
    onCancel,
    inputRef,
}: {
    depth: number;
    kind: "file" | "folder";
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
}) {
    const pad = 10 + depth * 13;
    return (
        <div className="tree-row tree-new" style={{ paddingLeft: pad + 13 }}>
            <span className="tree-file">{kind === "folder" ? <IconFolder size={17} /> : <FileIcon name="" size={20} />}</span>
            <input
                ref={inputRef}
                className="tree-new-input"
                placeholder={kind === "folder" ? "folder name…" : "filename…"}
                value={value}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => onChange(e.target.value)}
                onBlur={onCancel}
                onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmit();
                    else if (e.key === "Escape") onCancel();
                    e.stopPropagation();
                }}
            />
        </div>
    );
}

function RenameRow({
    depth,
    kind,
    value,
    onChange,
    onSubmit,
    onCancel,
    inputRef,
}: {
    depth: number;
    kind: "file" | "folder";
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
}) {
    // Folders sit at `pad`; files at `pad + 13` (chevron space). Match either
    // so the rename row lines up perfectly with the row it's replacing.
    const pad = 10 + depth * 13;
    return (
        <div className="tree-row tree-new" style={{ paddingLeft: kind === "folder" ? pad : pad }}>
            {kind === "folder" ? (
                <>
                    <span className="tree-chev" style={{ visibility: "hidden" }}>
                        <IconChevron size={11} />
                    </span>
                    <span className="tree-folder">
                        <IconFolder size={17} />
                    </span>
                </>
            ) : (
                <span className="tree-file">
                    <FileIcon name={value} size={20} />
                </span>
            )}
            <input
                ref={inputRef}
                className="tree-new-input"
                value={value}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => onChange(e.target.value)}
                onBlur={onCancel}
                onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmit();
                    else if (e.key === "Escape") onCancel();
                    e.stopPropagation();
                }}
            />
        </div>
    );
}
