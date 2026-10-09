import { emit } from "../bus";
import { collectPanes } from "../layout";
import { getState, mutate, type StoreState } from "../store";
import { ensureRoleWindow } from "./shared";
import { closeWindowById } from "./tabs";

function activeFilesWindow() {
    const st = getState();
    return (st.windowsBySession[st.activeSessionId] ?? []).map((id) => st.windows[id]).find((win) => win?.role === "files");
}

/** A preview is the tab a single click in the file tree borrows; the next preview takes its place. */
export function requestOpenFile(path: string, line?: number, character?: number, preview = false): void {
    const existed = !!activeFilesWindow();
    ensureRoleWindow("files", "editor", "editor", path);
    const created = !existed ? activeFilesWindow() : undefined;
    if (created && preview)
        mutate((d) => {
            const view = d.editorViews[created.activePaneId];
            if (view) view.preview = path;
        });
    emit({ type: "open-file", path, line, character, preview });
}

/** The editor has no page of its own to show, so it goes once its last file does. */
export function closeEmptyEditorWindow(paneId: string): void {
    const st = getState();
    const win = Object.values(st.windows).find(
        (candidate) => candidate.role === "files" && collectPanes(candidate.root).every((pane) => pane.id === paneId),
    );
    if (win) closeWindowById(win.id);
}

export const openEditorPane = (): void => ensureRoleWindow("files", "editor", "editor");

/** Opens `path` as a tab, and returns the preview tab it took the place of, if any. */
export function openEditorTab(paneId: string, path: string, activate = true, preview = false): string | null {
    let replaced: string | null = null;
    mutate((d) => {
        const cur = d.editorViews[paneId] ?? { openTabs: [], activePath: null };
        const previewIndex = cur.preview ? cur.openTabs.indexOf(cur.preview) : -1;
        if (cur.openTabs.includes(path)) {
            if (!preview && cur.preview === path) delete cur.preview;
        } else if (preview && previewIndex >= 0) {
            replaced = cur.openTabs[previewIndex];
            cur.openTabs[previewIndex] = path;
            if (cur.activePath === replaced) cur.activePath = path;
            cur.preview = path;
        } else {
            cur.openTabs.push(path);
            if (preview) cur.preview = path;
        }
        if (activate) cur.activePath = path;
        d.editorViews[paneId] = cur;
    });
    return replaced;
}

export function keepEditorTab(paneId: string, path: string): void {
    mutate((d) => {
        const cur = d.editorViews[paneId];
        if (cur?.preview === path) delete cur.preview;
    });
}

export function setEditorView(paneId: string, patch: Partial<StoreState["editorViews"][string]>): void {
    mutate((d) => {
        const cur = d.editorViews[paneId] ?? {
            openTabs: [],
            activePath: null,
        };
        d.editorViews[paneId] = { ...cur, ...patch };
    });
}

export function setEditorDirtyPaths(paneId: string, paths: string[]): void {
    mutate((d) => {
        if (paths.length === 0) delete d.dirtyEditorPaths[paneId];
        else d.dirtyEditorPaths[paneId] = paths;
    });
}
