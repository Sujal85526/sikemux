import { describe, expect, it } from "vitest";
import {
    actionForEvent,
    eventToKeybinding,
    findKeybindingConflict,
    keybindingHasModifier,
    keybindingLabel,
    normaliseKeybindingOverrides,
    resolvedKeybinding,
} from "./keybindings";

function key(code: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) {
    return {
        code,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...modifiers,
    };
}

describe("keybindings", () => {
    it("serializes physical keys and renders macOS labels", () => {
        const binding = eventToKeybinding(key("KeyF", { metaKey: true, shiftKey: true }));
        expect(binding).toBe("Meta+Shift+KeyF");
        expect(keybindingLabel(binding)).toBe("⌘⇧F");
        expect(keybindingLabel("Alt+Backslash")).toBe("⌥\\");
        expect(actionForEvent(key("NumpadEnter", { metaKey: true }), {})).toBe("bruno.send");
    });

    it("resolves defaults, replacements, and explicit unassignment", () => {
        expect(resolvedKeybinding({}, "settings.toggle")).toBe("Meta+Comma");
        expect(resolvedKeybinding({ "settings.toggle": "Ctrl+Comma" }, "settings.toggle")).toBe("Ctrl+Comma");
        expect(resolvedKeybinding({ "settings.toggle": null }, "settings.toggle")).toBeNull();
    });

    it("routes an event through overrides and reports conflicts", () => {
        const overrides = { "project.open": "Ctrl+KeyP" } as const;
        expect(actionForEvent(key("KeyP", { ctrlKey: true }), overrides)).toBe("project.open");
        expect(actionForEvent(key("KeyP", { altKey: true }), overrides)).toBeNull();
        expect(findKeybindingConflict(overrides, "aws.open", "Ctrl+KeyP")?.id).toBe("project.open");
    });

    it("requires a modifier for user-recorded shortcuts", () => {
        expect(keybindingHasModifier("KeyA")).toBe(false);
        expect(keybindingHasModifier("Shift+KeyA")).toBe(true);
    });

    it("sanitizes persisted overrides", () => {
        expect(
            normaliseKeybindingOverrides({
                "project.open": "Ctrl+KeyP",
                "pane.zoom": null,
                "unknown.action": "Meta+KeyU",
                "aws.open": "KeyA",
                "session.open": 42,
            }),
        ).toEqual({
            "project.open": "Ctrl+KeyP",
            "pane.zoom": null,
        });
    });
});
