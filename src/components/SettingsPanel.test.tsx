import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "../state/store";
import { SettingsPanel } from "./SettingsPanel";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
    setState({ keybindingOverrides: {}, settingsOpen: true });
});

describe("SettingsPanel keybindings", () => {
    it("records, blocks conflicts, clears, and resets shortcuts", async () => {
        const user = userEvent.setup();
        render(<SettingsPanel />);
        await user.click(screen.getByRole("button", { name: "KeybindingsCommands and navigation" }));

        const project = screen.getByRole("button", { name: "Open project: ⌥P. Activate to change." });
        await user.click(project);
        fireEvent.keyDown(project, { key: "Escape", code: "Escape" });
        expect(getState().settingsOpen).toBe(true);
        expect(screen.getByText("Change cancelled.")).toBeInTheDocument();

        await user.click(project);
        fireEvent.keyDown(project, { key: "o", code: "KeyO", metaKey: true, shiftKey: true });
        expect(getState().keybindingOverrides["project.open"]).toBe("Meta+Shift+KeyO");
        expect(screen.getByRole("button", { name: "Open project: ⌘⇧O. Activate to change." })).toBeInTheDocument();

        const aws = screen.getByRole("button", { name: "Open AWS: ⌥A. Activate to change." });
        await user.click(aws);
        fireEvent.keyDown(aws, { key: "o", code: "KeyO", metaKey: true, shiftKey: true });
        expect(getState().keybindingOverrides["aws.open"]).toBeUndefined();
        expect(screen.getByText("⌘⇧O is already assigned to “Open project”.")).toBeInTheDocument();

        fireEvent.keyDown(aws, { key: "Backspace", code: "Backspace" });
        expect(getState().keybindingOverrides["aws.open"]).toBeNull();
        expect(screen.getByRole("button", { name: "Open AWS: Unassigned. Activate to change." })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "reset all" }));
        expect(getState().keybindingOverrides).toEqual({});
    });
});
