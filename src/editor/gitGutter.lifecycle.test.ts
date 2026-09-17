import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { gitDiffGutter, setGitBaseline } from "./gitGutter";
import { diffApi } from "../api/diff";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("cancels delayed Git diff work when its document is replaced", async () => {
    vi.useFakeTimers();
    const hunks = vi.spyOn(diffApi, "hunks").mockResolvedValue([]);
    const view = new EditorView({ state: EditorState.create({ doc: "changed", extensions: gitDiffGutter() }) });
    setGitBaseline(view, "original");
    view.setState(EditorState.create({ doc: "next", extensions: gitDiffGutter() }));
    setGitBaseline(view, "next original");
    await vi.advanceTimersByTimeAsync(500);
    expect(hunks).toHaveBeenCalledTimes(1);
    expect(hunks).toHaveBeenCalledWith("next original", "next");
    view.destroy();
});

it("sends only the lines around a change and maps the hunks back onto the document", async () => {
    vi.useFakeTimers();
    const head = Array.from({ length: 200 }, (_, line) => `line ${line}`);
    const tail = Array.from({ length: 200 }, (_, line) => `tail ${line}`);
    const baseline = [...head, "before", ...tail].join("\n");
    const current = [...head, "after", ...tail].join("\n");
    const hunks = vi.spyOn(diffApi, "hunks").mockResolvedValue([{ kind: "mod", start: 0, end: 1 }]);

    const view = new EditorView({ state: EditorState.create({ doc: current, extensions: gitDiffGutter() }) });
    setGitBaseline(view, baseline);
    await vi.advanceTimersByTimeAsync(500);

    expect(hunks).toHaveBeenCalledWith("before", "after");
    expect(view.dom.querySelectorAll(".cm-git-ruler-bar")[0]?.getAttribute("title")).toBe("Modified lines 201–201");
    view.destroy();
});

it("leaves an unchanged baseline alone instead of re-running the diff", async () => {
    vi.useFakeTimers();
    const hunks = vi.spyOn(diffApi, "hunks").mockResolvedValue([]);
    const view = new EditorView({ state: EditorState.create({ doc: "changed", extensions: gitDiffGutter() }) });
    setGitBaseline(view, "original");
    await vi.advanceTimersByTimeAsync(500);
    expect(hunks).toHaveBeenCalledTimes(1);

    setGitBaseline(view, "original");
    await vi.advanceTimersByTimeAsync(500);
    expect(hunks).toHaveBeenCalledTimes(1);
    view.destroy();
});
