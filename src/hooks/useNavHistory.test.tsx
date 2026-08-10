import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { useNavHistory, type NavEntry } from "./useNavHistory";

function editorAt(line: number, character: number): EditorView {
    const from = line * 100;
    return {
        state: {
            selection: { main: { head: from + character } },
            doc: { lineAt: () => ({ number: line + 1, from }) },
        },
    } as unknown as EditorView;
}

describe("useNavHistory", () => {
    it("captures the origin and navigates backward and forward", () => {
        let path = "/repo/src/origin.ts";
        let view: EditorView | null = editorAt(4, 7);
        const scrollLiveTo = vi.fn();
        const openOther = vi.fn<(entry: NavEntry) => void>((entry) => {
            path = entry.path;
            view = editorAt(entry.line, entry.character);
        });
        const { result } = renderHook(() =>
            useNavHistory({ project: "/repo", getView: () => view, getCurrentPath: () => path, scrollLiveTo, openOther }),
        );

        act(() => result.current.push({ path: "/repo/src/target.ts", line: 9, character: 2 }));
        expect(openOther).toHaveBeenLastCalledWith({ path: "/repo/src/target.ts", line: 9, character: 2 });

        act(() => result.current.back());
        expect(openOther).toHaveBeenLastCalledWith({ path: "/repo/src/origin.ts", line: 4, character: 7 });

        act(() => result.current.forward());
        expect(openOther).toHaveBeenLastCalledWith({ path: "/repo/src/target.ts", line: 9, character: 2 });
        expect(scrollLiveTo).not.toHaveBeenCalled();
    });

    it("uses the live editor for same-document targets", () => {
        const view = editorAt(1, 3);
        const scrollLiveTo = vi.fn();
        const openOther = vi.fn();
        const { result } = renderHook(() =>
            useNavHistory({
                project: "/repo",
                getView: () => view,
                getCurrentPath: () => "/repo/src/file.ts",
                scrollLiveTo,
                openOther,
            }),
        );

        act(() => result.current.push({ path: "/repo/src/file.ts", line: 8, character: 5 }));
        expect(scrollLiveTo).toHaveBeenCalledWith(8, 5);
        expect(openOther).not.toHaveBeenCalled();
    });

    it("drops history when a pane is reused for another project", () => {
        const openOther = vi.fn();
        const props = {
            project: "/first",
            path: "/first/a.ts",
            view: editorAt(0, 0) as EditorView | null,
        };
        const { result, rerender } = renderHook(() =>
            useNavHistory({
                project: props.project,
                getView: () => props.view,
                getCurrentPath: () => props.path,
                scrollLiveTo: vi.fn(),
                openOther,
            }),
        );

        act(() => result.current.push({ path: "/first/b.ts", line: 1, character: 0 }));
        openOther.mockClear();
        props.project = "/second";
        props.path = "/second/a.ts";
        rerender();
        act(() => result.current.back());
        expect(openOther).not.toHaveBeenCalled();
    });
});
