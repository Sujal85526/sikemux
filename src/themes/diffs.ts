import { registerCustomTheme } from "@pierre/diffs";
import { codeThemeName, createCodeTheme } from "./codeTheme";
import type { Theme } from ".";

const registeredNames = new Set<string>();

export function diffsThemeName(theme: Theme): string {
    const name = codeThemeName(theme);
    if (!registeredNames.has(name)) {
        registerCustomTheme(name, async () => createCodeTheme(theme, name));
        registeredNames.add(name);
    }
    return name;
}
