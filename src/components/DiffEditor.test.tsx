import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { themeById } from "../themes";

const mocks = vi.hoisted(() => ({
    fileAt: vi.fn(),
    readTextFileLimited: vi.fn(),
    writeFile: vi.fn(),
    currentTheme: vi.fn(),
    themeListener: null as ((theme: ReturnType<typeof themeById>) => void) | null,
    diffProps: null as Record<string, any> | null,
    registeredThemes: [] as Array<{ name: string; loader: () => Promise<unknown> }>,
}));

vi.mock("@pierre/diffs", () => ({
    registerCustomTheme: (name: string, loader: () => Promise<unknown>) => mocks.registeredThemes.push({ name, loader }),
}));
vi.mock("@pierre/diffs/edit", () => ({ Editor: class {} }));
vi.mock("@pierre/diffs/react", () => ({
    EditProvider: ({ children }: { children: React.ReactNode }) => children,
    MultiFileDiff: (props: Record<string, any>) => {
        mocks.diffProps = props;
        return <div data-testid="pierre-diff" />;
    },
}));
vi.mock("../api/git", () => ({ git: { fileAt: mocks.fileAt } }));
vi.mock("../api/fs", () => ({
    fsapi: {
        readTextFileLimited: mocks.readTextFileLimited,
        writeFile: mocks.writeFile,
    },
}));
vi.mock("../themes/bus", () => ({
    currentTheme: mocks.currentTheme,
    subscribeTheme: (listener: (theme: ReturnType<typeof themeById>) => void) => {
        mocks.themeListener = listener;
        return () => {
            mocks.themeListener = null;
        };
    },
}));

import { DiffEditor } from "./DiffEditor";

beforeEach(() => {
    mocks.fileAt.mockReset().mockResolvedValue("const value = 1;\n");
    mocks.readTextFileLimited.mockReset().mockResolvedValue("const value = 2;\n");
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    mocks.currentTheme.mockReset().mockReturnValue(themeById("aura"));
    mocks.themeListener = null;
    mocks.diffProps = null;
});

afterEach(cleanup);

describe("DiffEditor", () => {
    it("renders with Pierre Diffs, inherits opacity, and saves edits", async () => {
        const onSaved = vi.fn();
        const { container, getByTestId } = render(<DiffEditor repo="/repo" path="src/app.ts" baseRev="HEAD" editable onSaved={onSaved} />);

        await waitFor(() => expect(getByTestId("pierre-diff")).toBeInTheDocument());
        expect(mocks.diffProps?.oldFile).toMatchObject({ name: "src/app.ts", contents: "const value = 1;\n" });
        expect(mocks.diffProps?.newFile).toMatchObject({ name: "src/app.ts", contents: "const value = 2;\n" });
        expect(mocks.diffProps?.options).toMatchObject({
            diffStyle: "unified",
            themeType: "dark",
            disableBackground: false,
            disableFileHeader: true,
        });
        expect(mocks.diffProps?.style["--diffs-bg"]).toContain("var(--window-opacity, 1)");
        expect(mocks.diffProps?.style["--diffs-addition-color-override"]).toBe("var(--live)");
        expect(mocks.diffProps?.style["--diffs-deletion-color-override"]).toBe("var(--danger)");

        act(() => mocks.diffProps?.editorOptions.onChange({ name: "src/app.ts", contents: "const value = 3;\n" }));
        fireEvent.keyDown(container.querySelector(".diff-editor")!, { key: "s", metaKey: true });

        await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith("/repo/src/app.ts", "const value = 3;\n"));
        expect(onSaved).toHaveBeenCalledOnce();
    });

    it("updates the renderer and Shiki palette when the app theme changes", async () => {
        const { getByTestId } = render(<DiffEditor repo="/repo" path="src/app.ts" baseRev="HEAD" headRev="main" editable={false} />);
        await waitFor(() => expect(getByTestId("pierre-diff")).toBeInTheDocument());

        act(() => mocks.themeListener?.(themeById("aura-day")));

        expect(mocks.diffProps?.options.themeType).toBe("light");
        expect(mocks.diffProps?.options.disableBackground).toBe(true);
        expect(mocks.diffProps?.style.colorScheme).toBe("light");
        expect(mocks.diffProps?.options.theme).toMatch(/^sikemux-aura-day-/);

        const registered = mocks.registeredThemes.find((entry) => entry.name === mocks.diffProps?.options.theme);
        const shikiTheme = (await registered?.loader()) as { type: string; colors: Record<string, string>; tokenColors: unknown[] };
        expect(shikiTheme).toMatchObject({
            type: "light",
            colors: {
                "editor.background": themeById("aura-day").chrome.bg,
                "editor.foreground": themeById("aura-day").editor.fg,
            },
        });
        expect(shikiTheme.tokenColors.length).toBeGreaterThan(10);
    });

    it("deduplicates simultaneous revision reads", async () => {
        render(
            <>
                <DiffEditor repo="/repo" path="src/shared.ts" baseRev="HEAD" headRev=":index" editable={false} />
                <DiffEditor repo="/repo" path="src/shared.ts" baseRev="HEAD" headRev=":index" editable={false} />
            </>,
        );

        await waitFor(() => expect(document.querySelectorAll('[data-testid="pierre-diff"]')).toHaveLength(2));
        expect(mocks.fileAt).toHaveBeenCalledTimes(2);
        expect(mocks.fileAt).toHaveBeenCalledWith("/repo", "HEAD", "src/shared.ts");
        expect(mocks.fileAt).toHaveBeenCalledWith("/repo", ":index", "src/shared.ts");
    });
});
