import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keybindingLabel, resolvedKeybinding } from "../keybindings";
import { getState, setState } from "../state/store";
import { SettingsPanel } from "./SettingsPanel";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
    setState({ keybindingOverrides: {}, settingsOpen: true });
});

afterEach(cleanup);

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

    it("toggles agent tab restoration", async () => {
        const user = userEvent.setup();
        setState({ restoreAgentTabs: true });
        render(<SettingsPanel />);
        await user.click(screen.getByRole("button", { name: "AgentsProfiles and launch safety" }));

        const restore = screen.getByRole("switch", { name: /Restore agent tabs/ });
        expect(restore).toBeChecked();

        await user.click(restore);
        expect(getState()).toMatchObject({ restoreAgentTabs: false });
        expect(restore).not.toBeChecked();
    });

    it("persists an explicit launch boundary and non-secret provider path", async () => {
        const user = userEvent.setup();
        render(<SettingsPanel />);
        await user.click(screen.getByRole("button", { name: "AgentsProfiles and launch safety" }));

        expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
            expect.stringContaining("Normal"),
            expect.stringContaining("YOLO"),
        ]);
        await user.click(screen.getByRole("radio", { name: /YOLO/ }));
        expect(getState().defaultAgentPermissionMode).toBe("bypass");

        await user.click(screen.getByRole("button", { name: /Codexcodex.*system PATH/ }));
        await user.type(screen.getByRole("textbox", { name: "executable path" }), "/opt/codex/bin/codex");
        await user.click(screen.getByRole("button", { name: "save profile" }));

        expect(getState().providerProfiles.find((profile) => profile.id === "builtin-codex")?.executablePath).toBe("/opt/codex/bin/codex");
    });

    it("configures separate themes for system light and dark appearances", async () => {
        const user = userEvent.setup();
        render(<SettingsPanel />);
        await user.click(screen.getByRole("button", { name: "AppearanceTheme and window" }));

        // The app dropdown is a button + listbox, not a native <select>.
        await user.click(screen.getByRole("button", { name: "Light appearance" }));
        await user.click(screen.getByRole("option", { name: /Aura Day/i }));
        await user.click(screen.getByRole("button", { name: "Dark appearance" }));
        await user.click(screen.getByRole("option", { name: /Dracula/i }));

        expect(getState()).toMatchObject({ systemLightThemeId: "aura-day", systemDarkThemeId: "dracula" });
    });
});
