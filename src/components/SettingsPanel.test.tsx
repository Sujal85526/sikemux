import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { keybindingLabel, resolvedKeybinding } from "../keybindings";
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

        const projectDefault = keybindingLabel(resolvedKeybinding({}, "project.open"));
        const project = screen.getByRole("button", { name: `Open project: ${projectDefault}. Activate to change.` });
        await user.click(project);
        fireEvent.keyDown(project, { key: "Escape", code: "Escape" });
        expect(getState().settingsOpen).toBe(true);
        expect(screen.getByText("Change cancelled.")).toBeInTheDocument();

        await user.click(project);
        fireEvent.keyDown(project, { key: "o", code: "KeyO", ctrlKey: true, shiftKey: true });
        expect(getState().keybindingOverrides["project.open"]).toBe("Ctrl+Shift+KeyO");
        const replacementLabel = keybindingLabel("Ctrl+Shift+KeyO");
        expect(screen.getByRole("button", { name: `Open project: ${replacementLabel}. Activate to change.` })).toBeInTheDocument();

        const awsDefault = keybindingLabel(resolvedKeybinding({}, "aws.open"));
        const aws = screen.getByRole("button", { name: `Open AWS: ${awsDefault}. Activate to change.` });
        await user.click(aws);
        fireEvent.keyDown(aws, { key: "o", code: "KeyO", ctrlKey: true, shiftKey: true });
        expect(getState().keybindingOverrides["aws.open"]).toBeUndefined();
        expect(screen.getByText(`${replacementLabel} is already assigned to “Open project”.`)).toBeInTheDocument();

        fireEvent.keyDown(aws, { key: "Backspace", code: "Backspace" });
        expect(getState().keybindingOverrides["aws.open"]).toBeNull();
        expect(screen.getByRole("button", { name: "Open AWS: Unassigned. Activate to change." })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "reset all" }));
        expect(getState().keybindingOverrides).toEqual({});
    });
});
