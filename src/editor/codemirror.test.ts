import { toggleComment } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { languageFor } from "./codemirror";

describe("editor languages", () => {
    it("highlights dotenv keys, values, and comments", () => {
        const state = EditorState.create({
            doc: "FIRST=one\n# explanation",
            extensions: languageFor(".env"),
        });
        const tree = ensureSyntaxTree(state, state.doc.length, 100);
        const spans: Array<{ text: string; classes: string }> = [];

        expect(tree).not.toBeNull();
        highlightTree(tree!, classHighlighter, (from, to, classes) => spans.push({ text: state.sliceDoc(from, to), classes }));

        expect(spans).toEqual(
            expect.arrayContaining([
                { text: "FIRST", classes: expect.stringContaining("tok-variableName") },
                { text: "one", classes: "tok-string" },
                { text: "# explanation", classes: "tok-comment" },
            ]),
        );
    });

    it.each([".env", ".env.local"])("toggles selected lines in %s files", (path) => {
        const doc = "FIRST=one\nSECOND=two";
        let state = EditorState.create({
            doc,
            selection: { anchor: 0, head: doc.length },
            extensions: languageFor(path),
        });

        expect(toggleComment({ state, dispatch: (transaction) => (state = transaction.state) })).toBe(true);
        expect(state.doc.toString()).toBe("# FIRST=one\n# SECOND=two");

        expect(toggleComment({ state, dispatch: (transaction) => (state = transaction.state) })).toBe(true);
        expect(state.doc.toString()).toBe(doc);
    });
});
