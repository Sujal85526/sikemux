import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Theme } from "../themes";
import { currentTheme, setEditorThemeBridge } from "../themes/bus";
import { buildEditorThemeExtensions, buildIndentMarkerExtensions } from "./themeExtensions";

const themeCompartment = new Compartment();
const indentCompartment = new Compartment();

let editorTheme: Extension = buildEditorThemeExtensions(currentTheme());
let indentTheme: Extension = buildIndentMarkerExtensions(currentTheme());

export function themeCompartmentExtension(opts: { indentMarkers?: boolean } = {}): Extension {
    return [themeCompartment.of(editorTheme), ...(opts.indentMarkers === false ? [] : [indentCompartment.of(indentTheme)])];
}

function pushThemeOnto(view: EditorView): void {
    const effects = [];
    if (themeCompartment.get(view.state) !== editorTheme) effects.push(themeCompartment.reconfigure(editorTheme));
    const indent = indentCompartment.get(view.state);
    if (indent !== undefined && indent !== indentTheme) effects.push(indentCompartment.reconfigure(indentTheme));
    if (effects.length) view.dispatch({ effects });
}

function rebuild(theme: Theme): void {
    editorTheme = buildEditorThemeExtensions(theme);
    indentTheme = buildIndentMarkerExtensions(theme);
}

// The theme bus holds every live editor but must not drag CodeMirror into the
// boot bundle, so this module hands it the two things it cannot do itself.
setEditorThemeBridge({ rebuild, push: pushThemeOnto });
