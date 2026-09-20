import { createContext, useContext, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { fsapi } from "../api/fs";
import { FileIcon } from "../components/FileIcon";
import { TreeContextMenu, type CtxItem } from "../components/FileTree";
import { IconFolder } from "../components/Icons";
import { copyText } from "../lib/clipboard";
import { basename, dirname, relativePath } from "../lib/paths";
import { FILE_MANAGER_NAME } from "../lib/platform";
import * as cmd from "../state/commands";
import { notify, reportError } from "../state/toast";
import { parsePathRef, type PathRef, type PathRoots } from "./filePath";
import { usePathState, type PathState } from "./pathExistence";

const PathRootsContext = createContext<PathRoots>({ cwd: "" });

/** Where a transcript's relative paths are relative to. */
export function PathRootsProvider({ cwd, home, children }: PathRoots & { children: ReactNode }) {
    const roots = useMemo(() => ({ cwd, home }), [cwd, home]);
    return <PathRootsContext.Provider value={roots}>{children}</PathRootsContext.Provider>;
}

export function usePathRoots(): PathRoots {
    return useContext(PathRootsContext);
}

/**
 * Reads a string as a file reference and looks it up. Both halves are null
 * until a path that exists comes back, so text that only reads like a filename
 * stays text.
 */
export function useFileRef(raw: string | null | undefined): { ref: PathRef; state: PathState } | null {
    const roots = usePathRoots();
    const ref = useMemo(() => (raw ? parsePathRef(raw, roots) : null), [raw, roots]);
    const state = usePathState(ref?.path ?? null);
    if (!ref || state === null || state === "missing") return null;
    return { ref, state };
}

function copy(value: string, label: string) {
    void copyText(value)
        .then(() => notify("success", `copied ${label}`))
        .catch(reportError("copy"));
}

export function openFileRef(ref: PathRef, state: PathState): void {
    if (state === "dir") {
        void fsapi.revealInFinder(ref.path).catch(reportError("reveal"));
        return;
    }
    cmd.requestOpenFile(ref.path, ref.line === undefined ? undefined : ref.line - 1, ref.column === undefined ? undefined : ref.column - 1);
}

function menuItems(ref: PathRef, state: PathState, cwd: string): CtxItem[] {
    const relative = relativePath(ref.path, cwd) ?? basename(ref.path);
    const reveal: CtxItem = {
        label: `Reveal in ${FILE_MANAGER_NAME}`,
        run: () => void fsapi.revealInFinder(ref.path).catch(reportError("reveal")),
    };
    const copies: CtxItem[] = [
        { label: "Copy Path", run: () => copy(ref.path, "path") },
        { label: "Copy Relative Path", run: () => copy(relative, "relative path") },
        { label: "Copy Name", run: () => copy(basename(ref.path), "name") },
    ];
    if (state === "dir") return [reveal, { sep: true }, ...copies];
    return [
        { label: "Open", run: () => openFileRef(ref, state) },
        { label: "Open Containing Folder", run: () => void fsapi.revealInFinder(dirname(ref.path)).catch(reportError("reveal")) },
        { sep: true },
        reveal,
        { sep: true },
        ...copies,
    ];
}

/**
 * A file the transcript names: its icon, what the agent called it, and the
 * line when one was given. It opens where the rest of the app opens files, and
 * its menu is the one the file tree offers.
 */
export function ChatFileRef({
    refers,
    state,
    label,
    size = 12,
    className = "chat-file-ref",
}: {
    refers: PathRef;
    state: PathState;
    label: ReactNode;
    size?: number;
    className?: string;
}) {
    const { cwd } = usePathRoots();
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const openMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
    };
    return (
        <>
            <button
                type="button"
                className={className}
                data-kind={state}
                title={refers.line === undefined ? refers.path : `${refers.path}:${refers.line}`}
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openFileRef(refers, state);
                }}
                onContextMenu={openMenu}>
                {state === "dir" ? (
                    <span className="file-glyph" aria-hidden="true">
                        <IconFolder size={size} />
                    </span>
                ) : (
                    <FileIcon name={basename(refers.path)} size={size} />
                )}
                <span className="chat-file-ref-name">{label}</span>
            </button>
            {menu && <TreeContextMenu x={menu.x} y={menu.y} items={menuItems(refers, state, cwd)} onClose={() => setMenu(null)} />}
        </>
    );
}
