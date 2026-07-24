import { toggleComment } from "@codemirror/commands";
import { ensureSyntaxTree, highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { auraExtensions, languageFor } from "./codemirror";

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

    it("highlights OpenSSH config structure", () => {
        const state = EditorState.create({
            doc: "Host staging\n  HostName staging.example.com\n  Port 2222\n  CanonicalizeHostname yes\n  ProxyCommand ssh -W %h:%p jump\n# note",
            extensions: languageFor("/Users/me/.ssh/config"),
        });
        const tree = ensureSyntaxTree(state, state.doc.length, 100);
        const spans: Array<{ text: string; classes: string }> = [];

        expect(tree).not.toBeNull();
        highlightTree(tree!, classHighlighter, (from, to, classes) => spans.push({ text: state.sliceDoc(from, to), classes }));

        expect(spans).toEqual(
            expect.arrayContaining([
                { text: "Host", classes: expect.stringContaining("tok-keyword") },
                { text: "HostName", classes: expect.stringContaining("tok-propertyName") },
                { text: "2222", classes: expect.stringContaining("tok-number") },
                { text: "yes", classes: expect.stringContaining("tok-bool") },
                { text: "%h", classes: expect.stringContaining("tok-variableName") },
                { text: "# note", classes: expect.stringContaining("tok-comment") },
            ]),
        );
    });

    it("honours the SSH config language hint independently of path", () => {
        const state = EditorState.create({
            doc: "Host production\n  HostName prod.example.com",
            extensions: languageFor("/tmp/config", "ssh-config"),
        });
        const tree = ensureSyntaxTree(state, state.doc.length, 100);
        const spans: Array<{ text: string; classes: string }> = [];

        expect(tree).not.toBeNull();
        highlightTree(tree!, classHighlighter, (from, to, classes) => spans.push({ text: state.sliceDoc(from, to), classes }));
        expect(spans).toEqual(
            expect.arrayContaining([
                { text: "Host", classes: expect.stringContaining("tok-keyword") },
                { text: "HostName", classes: expect.stringContaining("tok-propertyName") },
            ]),
        );
    });

    it("maps SSH tokens to the active editor theme", () => {
        const state = EditorState.create({
            doc: "Host production",
            extensions: [auraExtensions, languageFor("/tmp/config", "ssh-config")],
        });

        expect(highlightingFor(state, [tags.keyword])).toBeTruthy();
        expect(highlightingFor(state, [tags.propertyName])).toBeTruthy();
        expect(highlightingFor(state, [tags.string])).toBeTruthy();
    });
});
