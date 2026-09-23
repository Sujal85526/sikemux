import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPickers, sessionConfigs } from "./ComposerPickers";
import { getState, setState } from "../state/store";

const mocks = vi.hoisted(() => ({ onAgent: vi.fn() }));
const initial = getState();
afterEach(() => {
    cleanup();
    setState(initial, true);
    vi.clearAllMocks();
});

describe("composer pickers", () => {
    it("flattens provider model groups without changing their identifiers", () => {
        expect(
            sessionConfigs({
                configOptions: [
                    {
                        id: "model",
                        type: "select",
                        currentValue: "custom/model",
                        options: [{ group: "custom", name: "Custom provider", options: [{ value: "custom/model", name: "My model" }] }],
                    },
                ],
            })[0].options,
        ).toEqual([{ value: "custom/model", label: "My model", description: "Custom provider" }]);
    });

    it("names a model with the release number its description carries", () => {
        expect(
            sessionConfigs({
                configOptions: [
                    {
                        id: "model",
                        type: "select",
                        currentValue: "opus[1m]",
                        options: [
                            { value: "default", name: "Default (recommended)", description: "Opus (1M context)" },
                            {
                                value: "opus[1m]",
                                name: "Opus (1M context)",
                                description: "Opus 5 with 1M context · Best for everyday, complex tasks",
                            },
                            { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
                            { value: "haiku", name: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
                        ],
                    },
                ],
            })[0].options.map((option) => option.label),
        ).toEqual(["Default (recommended)", "Opus 5 (1M context)", "Sonnet 5", "Haiku 4.5"]);
    });

    it("selects the harness for the existing empty chat", () => {
        setState({ providerProfiles: [{ id: "work", name: "Work Claude", provider: "claude", accent: "#fff" }] });
        render(
            <ComposerPickers
                agent={{ id: "a", type: "codex", title: "Codex", startup: "codex" }}
                onAgent={mocks.onAgent}
                setup={{}}
                disabled={false}
                onConfig={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Agent" }));
        fireEvent.click(screen.getByRole("option", { name: /Work Claude/ }));
        expect(mocks.onAgent).toHaveBeenCalledWith("claude", "work");
    });

    it("lists a harness once when its built-in profile is the default", () => {
        render(
            <ComposerPickers
                agent={{ id: "a", type: "codex", title: "Codex", startup: "codex" }}
                onAgent={mocks.onAgent}
                setup={{}}
                disabled={false}
                onConfig={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Agent" }));
        expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Codex", "Claude"]);
        expect(screen.getByRole("option", { name: /Codex/ })).toHaveAttribute("aria-selected", "true");
    });

    it("drops the agent picker after messages while keeping model and effort available", () => {
        render(
            <ComposerPickers
                agent={{ id: "a", type: "codex", title: "Codex", startup: "codex" }}
                onAgent={mocks.onAgent}
                disabled={false}
                agentLocked
                onConfig={() => {}}
                setup={{
                    configOptions: [
                        { id: "model", type: "select", currentValue: "model", options: [{ value: "model", name: "My model" }] },
                        { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
                    ],
                }}
            />,
        );
        expect(screen.queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Model" }).querySelector(".agent-glyph.codex")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeEnabled();
    });

    it("picks a model when the click blurs the search without focusing anything", () => {
        const onConfig = vi.fn();
        render(
            <ComposerPickers
                agent={{ id: "a", type: "codex", title: "Codex", startup: "codex" }}
                onAgent={mocks.onAgent}
                disabled={false}
                onConfig={onConfig}
                setup={{
                    configOptions: [
                        {
                            id: "model",
                            type: "select",
                            currentValue: "sonnet",
                            options: [
                                { value: "sonnet", name: "Sonnet" },
                                { value: "opus", name: "Opus" },
                            ],
                        },
                    ],
                }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Model" }));
        const option = screen.getByRole("option", { name: /Opus/ });
        fireEvent.focusOut(screen.getByRole("combobox", { name: "Search model" }), { relatedTarget: null });
        fireEvent.click(option);
        expect(onConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "model" }), "opus");
    });

    it("closes the model menu with Escape and returns focus to its trigger", () => {
        render(
            <ComposerPickers
                agent={{ id: "a", type: "codex", title: "Codex", startup: "codex" }}
                onAgent={mocks.onAgent}
                disabled={false}
                onConfig={() => {}}
                setup={{ configOptions: [{ id: "model", type: "select", currentValue: "model", options: [{ value: "model", name: "My model" }] }] }}
            />,
        );
        const trigger = screen.getByRole("button", { name: "Model" });
        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Search model" }), { key: "Escape" });
        expect(trigger).toHaveFocus();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
});
