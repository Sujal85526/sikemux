import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { refreshBlame, setBlameContext } from "../editor/gitBlame";
import { isImagePath } from "../editor/media";
import { subscribe } from "../state/bus";

/**
 * Bind the editor's inline git-blame to the active file: points the blame
 * extension at it (which triggers an initial fetch) and re-blames on
 * `git-refresh` (commit / checkout / external change). Doc-edit re-blame is
 * handled inside the extension itself.
 */
export function useGitBlame(viewGetter: () => EditorView | null, cwd: string, activePath: string | null) {
    useEffect(() => {
        const view = viewGetter();
        if (!view) return;
        if (!activePath || !cwd || isImagePath(activePath) || !activePath.startsWith(`${cwd}/`)) {
            setBlameContext(view, null);
            return;
        }
        const rel = activePath.slice(cwd.length + 1);
        setBlameContext(view, { repo: cwd, path: rel });
        return subscribe("git-refresh", (e) => {
            if (e.repo !== cwd) return;
            refreshBlame(viewGetter());
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath, cwd]);
}
