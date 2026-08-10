import { useCallback, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { NavigationHistory, type NavigationLocation } from "../workbench/navigationHistory";

export interface NavEntry {
    path: string;
    line: number;
    character: number;
}

interface NavOptions {
    project: string;
    getView: () => EditorView | null;
    getCurrentPath: () => string | null;
    scrollLiveTo: (line: number, character: number) => void;
    openOther: (entry: NavEntry) => void;
}

export function useNavHistory(opts: NavOptions) {
    const optionsRef = useRef(opts);
    optionsRef.current = opts;
    const ownerRef = useRef<{ project: string; history: NavigationHistory } | null>(null);
    if (!ownerRef.current || ownerRef.current.project !== opts.project) {
        const project = opts.project;
        ownerRef.current = {
            project,
            history: new NavigationHistory({
                isLocationCurrent: (location) => location.project === project,
            }),
        };
    }

    const captureCurrentPos = useCallback((): NavEntry | null => {
        const current = optionsRef.current;
        const view = current.getView();
        const path = current.getCurrentPath();
        if (!view || !path) return null;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        return { path, line: line.number - 1, character: head - line.from };
    }, []);

    const navigateTo = useCallback((location: NavigationLocation) => {
        const current = optionsRef.current;
        const entry = { path: location.path, line: location.line ?? 0, character: location.column ?? 0 };
        if (entry.path === current.getCurrentPath() && current.getView()) {
            current.scrollLiveTo(entry.line, entry.character);
        } else {
            current.openOther(entry);
        }
    }, []);

    const push = useCallback(
        (target: NavEntry) => {
            const origin = captureCurrentPos();
            const owner = ownerRef.current;
            if (!owner) return;
            if (origin) {
                owner.history.push({ project: owner.project, path: origin.path, line: origin.line, column: origin.character });
            }
            const result = owner.history.push({
                project: owner.project,
                path: target.path,
                line: target.line,
                column: target.character,
            });
            if (result === "pushed" || result === "duplicate") {
                navigateTo({
                    project: owner.project,
                    path: target.path,
                    line: target.line,
                    column: target.character,
                });
            }
        },
        [captureCurrentPos, navigateTo],
    );

    const back = useCallback(() => {
        const target = ownerRef.current?.history.back();
        if (target) navigateTo(target);
    }, [navigateTo]);

    const forward = useCallback(() => {
        const target = ownerRef.current?.history.forward();
        if (target) navigateTo(target);
    }, [navigateTo]);

    return { push, back, forward };
}
