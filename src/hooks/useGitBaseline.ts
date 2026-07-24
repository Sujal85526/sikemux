import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { LARGE_DOC_BYTES } from "../editor/codemirror";
import { setGitBaseline } from "../editor/gitGutter";
import { isImagePath } from "../editor/media";
import { subscribe } from "../state/bus";
import { swallow } from "../state/toast";
import { relativePath } from "../lib/paths";

export function useGitBaseline(viewGetter: () => EditorView | null, cwd: string, activePath: string | null) {
    useEffect(() => {
        if (!activePath || !cwd || isImagePath(activePath)) return;
        const rel = relativePath(activePath, cwd);
        if (!rel) return;

        const refetch = () => {
            const view = viewGetter();
            if (!view || view.state.doc.length > LARGE_DOC_BYTES) return;
            git.fileAt(cwd, "HEAD", rel)
                .then((content) => {
                    if (viewGetter() !== view) return;
                    setGitBaseline(view, content);
                })
                .catch(swallow("git baseline"));
        };

        refetch();
        const unsub = subscribe("git-refresh", (e) => {
            if (e.repo !== cwd) return;
            refetch();
        });
        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath, cwd]);
}
