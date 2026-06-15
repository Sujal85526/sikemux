import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { basicSetup } from "codemirror";
import { auraExtensions } from "../../editor/codemirror";
import { registerView } from "../../themes/bus";

export type BrunoLang = "json" | "javascript" | "xml" | "markdown" | "text";

function langExt(lang: BrunoLang): Extension[] {
    switch (lang) {
        case "json":
            return [json()];
        case "javascript":
            return [javascript()];
        case "markdown":
            return [markdown()];
        case "xml":
            return [html()];
        default:
            return [];
    }
}

/**
 * Reusable CodeMirror surface for the Bruno pane — gives request bodies,
 * scripts, docs and response bodies real syntax highlighting on the shared
 * editor theme. Controlled via `value`; external changes (switching request /
 * tab) are pushed into the doc without disturbing live typing.
 */
export function BrunoCode({
    value,
    lang,
    readOnly = false,
    placeholder,
    className = "",
    onChange,
}: {
    value: string;
    lang: BrunoLang;
    readOnly?: boolean;
    placeholder?: string;
    className?: string;
    onChange?: (text: string) => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const lastValue = useRef(value);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        const extensions: Extension[] = [
            basicSetup,
            auraExtensions,
            ...langExt(lang),
            EditorView.lineWrapping,
            EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                const text = u.state.doc.toString();
                lastValue.current = text;
                onChangeRef.current?.(text);
            }),
        ];
        if (placeholder) extensions.push(cmPlaceholder(placeholder));
        if (readOnly) extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));

        const view = new EditorView({
            parent: hostRef.current!,
            state: EditorState.create({ doc: lastValue.current, extensions }),
        });
        viewRef.current = view;
        const unregister = registerView(view);
        return () => {
            unregister();
            view.destroy();
            viewRef.current = null;
        };
        // recreate when language / read-only / placeholder identity changes
    }, [lang, readOnly, placeholder]);

    // Push external value changes (request or tab switch) into the editor.
    useEffect(() => {
        const view = viewRef.current;
        if (!view || value === lastValue.current) return;
        lastValue.current = value;
        const sel = Math.min(view.state.selection.main.head, value.length);
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            selection: { anchor: sel },
        });
    }, [value]);

    return <div ref={hostRef} className={`bruno-cm${className ? ` ${className}` : ""}`} />;
}
