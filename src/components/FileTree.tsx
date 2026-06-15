import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { fsapi, type DirEntry } from "../api/fs";
import { type GitFile } from "../api/git";
import { subscribe } from "../state/bus";
import { useResourceEnabled } from "../state/resources";
import { gitStatusR } from "../state/resources.defs";
import { notify, reportError, swallow } from "../state/toast";
import { registerFolderDrop } from "../state/dropRegistry";
import { IconChevron, IconFolder, IconPlus } from "./Icons";
import { FileIcon } from "./FileIcon";
import { basename, dirname } from "../lib/paths";

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
    revealPath?: string | null;
}

interface NewEntryRequest {
    parent: string;
    kind: "file" | "folder";
}

interface MenuState {
    x: number;
    y: number;
    entry: DirEntry | null;
}

export interface CtxItem {
    label?: string;
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    sep?: boolean;
    run?: () => void;
}

function validEntryName(raw: string): string | null {
    const name = raw.trim();
    if (!name) return null;
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
    return name;
}

export function FileTree({ cwd, activePath, onOpenFile, width, onResize, active, revealPath }: FileTreeProps) {
    const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selectedDir, setSelectedDir] = useState<string | null>(null);
    const [newRequest, setNewRequest] = useState<NewEntryRequest | null>(null);
    const [newName, setNewName] = useState("");
    const newInputRef = useRef<HTMLInputElement>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameName, setRenameName] = useState("");
    const renameInputRef = useRef<HTMLInputElement>(null);
    const [dragOver, setDragOver] = useState<string | null>(null);
    const [rootDragOver, setRootDragOver] = useState(false);
    const [draggingPath, setDraggingPath] = useState<string | null>(null);
    const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number } | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);

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

    useEffect(() => {
        if (!cwd || !active) return;
        void loadDir(cwd);
    }, [cwd, active, loadDir]);

    useEffect(() => {
        if (!cwd || !active) return;
        const unsubscribe = subscribe("fs-changed", (e) => {
            if (e.repo && e.repo !== cwd) return;
            void loadDir(cwd);
            for (const p of expandedRef.current) void loadDir(p);
        });
        return unsubscribe;
    }, [cwd, active, loadDir]);

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
        const trimmed = validEntryName(renameName);
        if (!trimmed) {
            notify("error", "name must be a single file or folder name");
            return;
        }
        if (trimmed === basename(renaming)) {
            cancelRename();
            return;
        }
        const lastSlash = renaming.lastIndexOf("/");
        const dest = `${renaming.slice(0, lastSlash)}/${trimmed}`;
        try {
            await fsapi.rename(renaming, dest);
            const parent = renaming.slice(0, lastSlash);
            await loadDir(parent);
            cancelRename();
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

    const startNew = (kind: "file" | "folder", parentOverride?: string) => {
        let parent = parentOverride ?? selectedDir;
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
        const name = validEntryName(newName);
        if (!name) {
            notify("error", "name must be a single file or folder name");
            return;
        }
        const target = `${newRequest.parent}/${name}`;
        try {
            if (newRequest.kind === "file") await fsapi.createFile(target);
            else await fsapi.createDir(target);
            await loadDir(newRequest.parent);
            cancelNew();
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

    const folderUnregRef = useRef<Map<HTMLElement, () => void>>(new Map());
    const attachFolderDrop = (el: HTMLButtonElement | null, dir: string) => {
        if (!el) return;
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

    // Internal drag-and-drop: move a file/folder within the tree (VSCode-style).
    // External Finder drops are handled separately via registerFolderDrop above.
    const canDropInto = (src: string, destDir: string): boolean => {
        if (!src) return false;
        if (destDir === src) return false; // into itself
        if (destDir.startsWith(`${src}/`)) return false; // into its own descendant
        if (dirname(src) === destDir) return false; // already lives there
        return true;
    };

    const moveEntry = async (src: string, destDir: string) => {
        if (!canDropInto(src, destDir)) return;
        const dest = `${destDir}/${basename(src)}`;
        try {
            await fsapi.rename(src, dest);
            await Promise.all([loadDir(dirname(src)), loadDir(destDir)]);
            setExpanded((s) => new Set(s).add(destDir));
        } catch (err) {
            reportError("move")(err);
        }
    };

    // Internal drag uses pointer events, NOT the HTML5 DnD API: Tauri's native OS
    // drag-drop handler (required for Finder→app drops) swallows dragover/drop on
    // macOS WKWebView, so in-app HTML5 dragging never fires its events. Pointer
    // events are fully under our control and immune to that.
    const dragSession = useRef<{ path: string; startX: number; startY: number; active: boolean } | null>(null);
    const moveHandlerRef = useRef<((e: PointerEvent) => void) | null>(null);
    const suppressClickRef = useRef(false);

    // What sits under (x, y): the destination dir + the folder/root to highlight.
    const resolveDrop = (x: number, y: number): { destDir: string | null; highlightPath: string | null } => {
        const at = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!at?.closest(".ed-tree-scroll")) return { destDir: null, highlightPath: null };
        const rowEl = at.closest(".tree-row.is-folder, .tree-row.file") as HTMLElement | null;
        if (rowEl?.dataset.folderPath) {
            return { destDir: rowEl.dataset.folderPath, highlightPath: rowEl.dataset.folderPath };
        }
        if (rowEl?.dataset.filePath) {
            const destDir = dirname(rowEl.dataset.filePath);
            return { destDir, highlightPath: destDir === cwd ? null : destDir };
        }
        return { destDir: cwd, highlightPath: null };
    };

    const onDragMove = (e: PointerEvent) => {
        const s = dragSession.current;
        if (!s) return;
        if (!s.active) {
            if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < 5) return; // click vs drag threshold
            s.active = true;
            setDraggingPath(s.path);
        }
        const { destDir, highlightPath } = resolveDrop(e.clientX, e.clientY);
        const ok = destDir != null && canDropInto(s.path, destDir);
        setDragOver(ok ? highlightPath : null);
        setRootDragOver(ok && !highlightPath);
        setDragGhost({ name: basename(s.path), x: e.clientX, y: e.clientY });
    };

    const endDrag = () => {
        if (moveHandlerRef.current) window.removeEventListener("pointermove", moveHandlerRef.current);
        moveHandlerRef.current = null;
        dragSession.current = null;
        setDraggingPath(null);
        setDragOver(null);
        setRootDragOver(false);
        setDragGhost(null);
    };

    const onDragUp = (e: PointerEvent) => {
        const s = dragSession.current;
        const active = !!s?.active;
        if (s && active) {
            const { destDir } = resolveDrop(e.clientX, e.clientY);
            if (destDir) void moveEntry(s.path, destDir);
        }
        endDrag();
        // Swallow the click that fires after a real drag. A click only fires when
        // pointer up/down share an element (drag back onto the source); dropping
        // elsewhere fires no click, so reset on the next tick to avoid eating a
        // later legit click.
        suppressClickRef.current = active;
        if (active) setTimeout(() => (suppressClickRef.current = false), 0);
    };

    const onRowPointerDown = (e: ReactPointerEvent, path: string) => {
        if (e.button !== 0) return; // left button only
        dragSession.current = { path, startX: e.clientX, startY: e.clientY, active: false };
        moveHandlerRef.current = onDragMove;
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragUp, { once: true });
    };

    // Defensive: drop the move listener if we unmount mid-drag.
    useEffect(() => () => endDrag(), []);

    useEffect(() => {
        if (!active || !cwd) return;
        return subscribe("tree-native-drag-hover", (e) => {
            if (dragSession.current?.active) return;
            if (e.cwd !== cwd || !e.targetDir) {
                setDragOver(null);
                setRootDragOver(false);
                return;
            }
            setDragOver(e.highlightPath);
            setRootDragOver(!e.highlightPath);
        });
    }, [active, cwd]);

    // ---- right-click context menu -------------------------------------
    const relativePath = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : basename(p));

    const copyText = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            notify("success", `copied ${label}`);
        } catch (err) {
            reportError("copy")(err);
        }
    };

    const revealInFinder = (p: string) => void fsapi.revealInFinder(p).catch(reportError("reveal"));

    const deleteEntry = async (entry: DirEntry) => {
        if (!window.confirm(`Move "${entry.name}" to the Trash?`)) return;
        try {
            await fsapi.deletePath(entry.path);
            await loadDir(dirname(entry.path) || cwd);
            if (renaming === entry.path) cancelRename();
            if (selectedDir === entry.path) setSelectedDir(null);
            if (newRequest?.parent === entry.path) cancelNew();
        } catch (err) {
            reportError("delete")(err);
        }
    };

    const openMenu = (e: ReactMouseEvent, entry: DirEntry | null) => {
        e.preventDefault();
        e.stopPropagation();
        if (entry?.is_dir) setSelectedDir(entry.path);
        setMenu({ x: e.clientX, y: e.clientY, entry });
    };

    const buildMenuItems = (entry: DirEntry | null): CtxItem[] => {
        if (!entry) {
            return [
                { label: "New File", run: () => startNew("file", cwd) },
                { label: "New Folder", run: () => startNew("folder", cwd) },
                { sep: true },
                { label: "Reveal in Finder", run: () => revealInFinder(cwd) },
                { label: "Copy Path", run: () => void copyText(cwd, "path") },
            ];
        }
        const tail: CtxItem[] = [
            { label: "Reveal in Finder", run: () => revealInFinder(entry.path) },
            { label: "Copy Path", run: () => void copyText(entry.path, "path") },
            { label: "Copy Relative Path", run: () => void copyText(relativePath(entry.path), "relative path") },
        ];
        if (entry.is_dir) {
            return [
                { label: "New File", run: () => startNew("file", entry.path) },
                { label: "New Folder", run: () => startNew("folder", entry.path) },
                { sep: true },
                { label: "Rename…", run: () => startRename(entry) },
                { label: "Delete", danger: true, run: () => void deleteEntry(entry) },
                { sep: true },
                ...tail,
            ];
        }
        return [
            {
                label: "Open",
                run: () => {
                    setSelectedDir(null);
                    onOpenFile(entry);
                },
            },
            { sep: true },
            { label: "Rename…", run: () => startRename(entry) },
            { label: "Delete", danger: true, run: () => void deleteEntry(entry) },
            { sep: true },
            ...tail,
        ];
    };

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
                                className={`tree-row is-folder${selectedDir === e.path ? " selected" : ""}${dragOver === e.path ? " drag-over" : ""}${draggingPath === e.path ? " dragging" : ""}`}
                                style={{ paddingLeft: pad }}
                                onPointerDown={(ev) => onRowPointerDown(ev, e.path)}
                                onDragStart={(ev) => ev.preventDefault()}
                                onClick={() => {
                                    if (suppressClickRef.current) {
                                        suppressClickRef.current = false;
                                        return;
                                    }
                                    void toggleDir(e);
                                }}
                                onDoubleClick={() => startRename(e)}
                                onContextMenu={(ev) => openMenu(ev, e)}
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
                            className={`tree-row file${activePath === e.path ? " active" : ""}${gd ? ` git-${gd.cls}` : ""}${dragOver === e.path ? " drag-over" : ""}${draggingPath === e.path ? " dragging" : ""}`}
                            style={{ paddingLeft: pad + 13 }}
                            onPointerDown={(ev) => onRowPointerDown(ev, e.path)}
                            onDragStart={(ev) => ev.preventDefault()}
                            onClick={() => {
                                if (suppressClickRef.current) {
                                    suppressClickRef.current = false;
                                    return;
                                }
                                setSelectedDir(null);
                                onOpenFile(e);
                            }}
                            onDoubleClick={() => startRename(e)}
                            onContextMenu={(ev) => openMenu(ev, e)}
                            data-file-path={e.path}
                            data-drop-dir={dirname(e.path)}>
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

    return (
        <>
            <div className="ed-tree" style={{ width }}>
                <div className="ed-tree-head">
                    <span className="ed-tree-name">{basename(cwd) || "files"}</span>
                    <span className="ed-tree-actions">
                        <button type="button" className="ed-tree-act" title="New file — a" onClick={() => startNew("file")}>
                            <FileIcon name="" size={13} />
                            <IconPlus size={9} />
                        </button>
                        <button type="button" className="ed-tree-act" title="New folder — ⇧A" onClick={() => startNew("folder")}>
                            <IconFolder size={13} />
                            <IconPlus size={9} />
                        </button>
                    </span>
                </div>
                <div
                    ref={rootScrollRef}
                    className={`ed-tree-scroll${rootDragOver ? " drag-over-root" : ""}`}
                    data-root-path={cwd}
                    onContextMenu={(ev) => openMenu(ev, null)}>
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
            {menu && <TreeContextMenu x={menu.x} y={menu.y} items={buildMenuItems(menu.entry)} onClose={() => setMenu(null)} />}
            {dragGhost &&
                createPortal(
                    <div className="tree-drag-ghost" style={{ left: dragGhost.x + 12, top: dragGhost.y + 10 }}>
                        {dragGhost.name}
                    </div>,
                    document.body,
                )}
        </>
    );
}

export function TreeContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const pad = 6;
        let left = x;
        let top = y;
        if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
        if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
        setPos({ left, top });
    }, [x, y]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    return createPortal(
        <div
            className="tree-ctx-scrim"
            onClick={onClose}
            onContextMenu={(e) => {
                e.preventDefault();
                onClose();
            }}>
            <div ref={ref} className="tree-ctx-menu" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
                {items.map((it, i) =>
                    it.sep ? (
                        <div key={i} className="tree-ctx-sep" />
                    ) : (
                        <button
                            key={i}
                            type="button"
                            disabled={it.disabled}
                            className={`tree-ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
                            onClick={() => {
                                if (it.disabled) return;
                                onClose();
                                it.run?.();
                            }}>
                            <span className="tree-ctx-label">{it.label}</span>
                            {it.hint && <span className="tree-ctx-hint">{it.hint}</span>}
                        </button>
                    ),
                )}
            </div>
        </div>,
        document.body,
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
    const pad = 10 + depth * 13;
    return (
        <div className="tree-row tree-new" style={{ paddingLeft: pad }}>
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
