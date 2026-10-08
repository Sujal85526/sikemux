import { memo, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as cmd from "../state/commands";
import { editorPaneOf } from "../state/selectors";
import { getState, useStore, type StoreState } from "../state/store";
import { FileTree } from "./FileTree";
import { leavingRail } from "./railMotion";

function activeProjectCwd(s: StoreState): string {
    const session = s.sessions[s.activeSessionId];
    return session?.kind === "project" ? session.cwd : "";
}

function shownEditorPath(s: StoreState): string | null {
    const files = (s.windowsBySession[s.activeSessionId] ?? []).map((id) => s.windows[id]).find((win) => win?.role === "files");
    return files ? (s.editorViews[editorPaneOf(files, s.editorViews)]?.activePath ?? null) : null;
}

function FilesRailResizer() {
    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        const start = e.clientX;
        const startWidth = getState().fileTreeWidth;
        let frame: number | null = null;
        let pending: number | null = null;
        const commit = () => {
            frame = null;
            if (pending !== null) cmd.setFileTreeWidth(pending);
            pending = null;
        };
        const move = (ev: PointerEvent) => {
            pending = startWidth + ev.clientX - start;
            if (frame == null) frame = window.requestAnimationFrame(commit);
        };
        const up = () => {
            if (frame != null) window.cancelAnimationFrame(frame);
            commit();
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const direction = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (!direction) return;
        e.preventDefault();
        cmd.setFileTreeWidth(getState().fileTreeWidth + direction * (e.shiftKey ? 40 : 16));
    };
    return (
        <div
            className="files-rail-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file tree"
            tabIndex={0}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
        />
    );
}

/** The project's files, docked beside whatever the stage shows. A file opens as a tab of its own. */
export const FilesRail = memo(function FilesRail() {
    const cwd = useStore(activeProjectCwd);
    const open = useStore((s) => s.fileTreeOpen);
    const width = useStore((s) => s.fileTreeWidth);
    const activePath = useStore(shownEditorPath);
    return (
        <aside
            ref={leavingRail}
            className="workspace-rail files-rail"
            aria-label="Project files"
            style={{ "--files-rail-w": `${width}px` } as CSSProperties}>
            {cwd && (
                <FileTree
                    key={cwd}
                    cwd={cwd}
                    active={open}
                    activePath={activePath}
                    onOpenFile={(entry) => cmd.requestOpenFile(entry.path, undefined, undefined, true)}
                    onKeepFile={(entry) => cmd.requestOpenFile(entry.path)}
                />
            )}
            <FilesRailResizer />
        </aside>
    );
});
