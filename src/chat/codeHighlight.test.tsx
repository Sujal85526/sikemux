import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeTokens, fenceLanguage, useCodeTokens } from "./codeHighlight";
import type { CodeLine } from "./types";

const tokenizeCode = vi.fn<(text: string, lang: string) => Promise<CodeLine[]>>();

vi.mock("./shikiTokens", () => ({
    tokenizeCode: (text: string, lang: string) => tokenizeCode(text, lang),
}));

function Fence({ text, lang }: { text: string; lang: string | null }) {
    const lines = useCodeTokens(text, lang);
    return <pre data-testid="fence">{lines ? <CodeTokens lines={lines} /> : text}</pre>;
}

const coloured = (text: string): CodeLine[] => text.split("\n").map((line) => [{ text: line, color: "#c792ea" }]);

beforeEach(() => {
    vi.useFakeTimers();
    tokenizeCode.mockImplementation((text) => Promise.resolve(coloured(text)));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
});

/** Lets the settle timer fire and the tokens come back. */
async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
    });
}

describe("fenceLanguage", () => {
    it("reads the word after the backticks, or the file the fence names", () => {
        expect(fenceLanguage("ts")).toBe("typescript");
        expect(fenceLanguage("TSX")).toBe("typescript");
        expect(fenceLanguage("src/styles/chat.css")).toBe("css");
        expect(fenceLanguage("src/chat/AgentChatPane.tsx:412")).toBe("typescript");
        expect(fenceLanguage("bash")).toBe("shellscript");
    });

    it("leaves a fence alone when the grammar is not one we carry", () => {
        expect(fenceLanguage(undefined)).toBeNull();
        expect(fenceLanguage("")).toBeNull();
        expect(fenceLanguage("brainfuck")).toBeNull();
        expect(fenceLanguage("notes.txt")).toBeNull();
    });
});

describe("useCodeTokens", () => {
    it("colours a fence once it settles and keeps the text it was given", async () => {
        render(<Fence text={"const value = 1;\nexport default value;"} lang="typescript" />);
        expect(tokenizeCode).not.toHaveBeenCalled();

        await settle();

        expect(tokenizeCode).toHaveBeenCalledOnce();
        expect(screen.getByTestId("fence")).toHaveTextContent("const value = 1; export default value;");
        expect(screen.getByTestId("fence").querySelector("span")).toHaveStyle({ color: "#c792ea" });
    });

    /* A message still being written re-reads its markdown ten times a second,
       and the fence at the end of it is longer every time. */
    it("leaves a fence that is still being written alone until it stops growing", async () => {
        const { rerender } = render(<Fence text="const a" lang="typescript" />);
        for (const text of ["const a =", "const a = 1", "const a = 1;"]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
            });
            rerender(<Fence text={text} lang="typescript" />);
        }
        expect(tokenizeCode).not.toHaveBeenCalled();

        await settle();
        expect(tokenizeCode).toHaveBeenCalledOnce();
        expect(tokenizeCode).toHaveBeenCalledWith("const a = 1;", "typescript");
    });

    it("reads a fence it has already coloured out of the cache", async () => {
        const source = "const cached = true;";
        const { unmount } = render(<Fence text={source} lang="typescript" />);
        await settle();
        expect(tokenizeCode).toHaveBeenCalledOnce();
        unmount();

        render(<Fence text={source} lang="typescript" />);
        // A row coming back on screen paints coloured on its first frame.
        expect(screen.getByTestId("fence").querySelector("span")).toHaveStyle({ color: "#c792ea" });
        await settle();
        expect(tokenizeCode).toHaveBeenCalledOnce();
    });

    it("never reads a block too long to be worth colouring", async () => {
        render(<Fence text={"x = 1;\n".repeat(151)} lang="typescript" />);
        await settle();
        expect(tokenizeCode).not.toHaveBeenCalled();

        cleanup();
        render(<Fence text={"y".repeat(6_001)} lang="typescript" />);
        await settle();
        expect(tokenizeCode).not.toHaveBeenCalled();

        cleanup();
        render(<Fence text={"x = 1;\n".repeat(120)} lang="typescript" />);
        await settle();
        expect(tokenizeCode).toHaveBeenCalledOnce();
    });

    it("leaves a fence with no grammar as plain text", async () => {
        render(<Fence text="hello" lang={null} />);
        await settle();
        expect(tokenizeCode).not.toHaveBeenCalled();
        expect(screen.getByTestId("fence").querySelector("span")).toBeNull();
    });
});
