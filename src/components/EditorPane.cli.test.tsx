import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";
import { getState, setState } from "../state/store";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./EditorFindBar", () => ({ EditorFindBar: () => null }));

const initial = getState();

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

describe("EditorPane CLI queue", () => {
    beforeEach(() => {
        setState(initial, true);
        invoke.mockReset();
        invoke.mockImplementation(async (command: string) => {
            if (command === "read_file") return "# Preview heading\n\n**locked**\nthird";
            if (command === "read_file_versioned") return { content: "# Preview heading\n\n**locked**\nthird", version: "version-1" };
            if (command === "cli_open_result") return undefined;
            if (command === "repo_watch_start") return 1;
            return null;
        });
        setState({
            editorViews: { pane: { openTabs: [], activePath: null, treeWidth: 210 } },
            pendingEditorOpens: {
                pane: [
                    {
                        requestId: "request-1",
                        id: "target-1",
                        kind: "file",
                        path: "/repo/README.md",
                        projectRoot: "/repo",
                        line: 1,
                        column: 2,
                    },
                ],
            },
        });
    });

    it("loads, activates, and acknowledges a queued file", async () => {
        render(<EditorPane paneId="pane" cwd="/repo" active visible showTree={false} />);

        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith("cli_open_result", {
                result: {
                    requestId: "request-1",
                    targetId: "target-1",
                    paneId: "pane",
                    path: "/repo/README.md",
                    error: null,
                },
            }),
        );
        expect(getState().editorViews.pane).toMatchObject({
            openTabs: ["/repo/README.md"],
            activePath: "/repo/README.md",
        });
        expect(getState().pendingEditorOpens).toEqual({});
    });

    it("renders the in-memory Markdown and disables source editing in preview mode", async () => {
        const { container } = render(<EditorPane paneId="pane" cwd="/repo" active visible showTree={false} />);
        const editor = within(container);

        const sourceButton = await editor.findByRole("button", { name: "Show source for README.md" });
        const previewButton = editor.getByRole("button", { name: "Preview README.md" });
        expect(sourceButton).toHaveAttribute("aria-pressed", "true");
        expect(previewButton).toHaveAttribute("aria-pressed", "false");
        expect(previewButton.querySelector("svg")).toBeInTheDocument();
        fireEvent.click(previewButton);

        expect(sourceButton).toHaveAttribute("aria-pressed", "false");
        expect(previewButton).toHaveAttribute("aria-pressed", "true");
        expect(editor.getByRole("heading", { name: "Preview heading" })).toBeInTheDocument();
        expect(editor.getByText("locked", { selector: "strong" })).toBeInTheDocument();
        expect(container.querySelector(".ed-host")).toHaveClass("preview-mode");
        expect(container.querySelector(".ed-source-host")).toHaveAttribute("hidden");
        expect(container.querySelector(".ed-source-host")).toHaveAttribute("aria-hidden", "true");
        expect(container.querySelector(".cm-content")).toHaveAttribute("contenteditable", "false");

        fireEvent.click(sourceButton);

        expect(sourceButton).toHaveAttribute("aria-pressed", "true");
        expect(previewButton).toHaveAttribute("aria-pressed", "false");
        expect(editor.queryByRole("heading", { name: "Preview heading" })).not.toBeInTheDocument();
        expect(container.querySelector(".ed-host")).not.toHaveClass("preview-mode");
        expect(container.querySelector(".ed-source-host")).not.toHaveAttribute("hidden");
        expect(container.querySelector(".ed-source-host")).toHaveAttribute("aria-hidden", "false");
        expect(container.querySelector(".cm-content")).toHaveAttribute("contenteditable", "true");
    });
});
