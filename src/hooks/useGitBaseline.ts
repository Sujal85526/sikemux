import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { setGitBaseline } from "../editor/gitGutter";
import { subscribe } from "../state/bus";
import { swallow } from "../state/toast";

export function useGitBaseline(viewGetter: () => EditorView | null, cwd: string, activePath: string | null) {
    useEffect(() => {
        if (!activePath || !cwd || !activePath.startsWith(`${cwd}/`)) return;
        const rel = activePath.slice(cwd.length + 1);

        const refetch = () => {
            const view = viewGetter();
            if (!view) return;
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
