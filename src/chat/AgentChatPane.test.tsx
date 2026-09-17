import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpApi, type AcpEvent } from "../api/acp";
import { dispatchPathDrop } from "../state/dropRegistry";
import type { Agent } from "../state/types";
import { AgentChatPane } from "./AgentChatPane";

const mocks = vi.hoisted(() => ({
    eventListener: null as ((event: AcpEvent) => void) | null,
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => "injected"),
    setPermissionMode: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
    setConfig: vi.fn(),
    setAgentModelPreferences: vi.fn(),
    attachAgentSession: vi.fn(),
    setAgentPermissionMode: vi.fn(),
    noteAcpAgentState: vi.fn(),
    start: vi.fn(async () => ({ sessionId: "session-1", capabilities: {}, setup: {} })),
}));

vi.mock("../api/acp", () => ({
    acpApi: {
        subscribe: vi.fn(async (listener: (event: AcpEvent) => void) => {
            mocks.eventListener = listener;
            return () => {
                mocks.eventListener = null;
            };
        }),
        start: mocks.start,
        setPermissionMode: mocks.setPermissionMode,
        setConfig: mocks.setConfig,
        stop: vi.fn(async () => {}),
        prompt: mocks.prompt,
        steer: mocks.steer,
        cancel: vi.fn(async () => {}),
        stopTask: mocks.stopTask,
        permissionReply: vi.fn(async () => {}),
    },
}));

vi.mock("../state/commands", () => ({
    attachAgentSession: mocks.attachAgentSession,
    setAgentPermissionMode: mocks.setAgentPermissionMode,
    setAgentModelPreferences: mocks.setAgentModelPreferences,
    setAgentTitle: vi.fn(),
    noteAcpAgentState: mocks.noteAcpAgentState,
    toggleAgentSkipPermissions: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const agent: Agent = {
    id: "agent-1",
    type: "codex",
    title: "Agent session",
    startup: "codex",
    permissionMode: "workspace-write",
    launchState: "live",
};

function emit(kind: AcpEvent["kind"], payload: Record<string, unknown>): void {
    act(() => mocks.eventListener?.({ agentId: agent.id, kind, payload }));
}

// jsdom reports no sizes and never fires a resize, so a scroller and the
// observer watching it both have to be played by hand. Callbacks are kept per
// target: the transcript virtualizer watches its own rows and must not be
// handed a resize meant for the scroll content.
const resizeCallbacks = new Map<Element, Set<ResizeObserverCallback>>();

class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
        const watchers = resizeCallbacks.get(target) ?? new Set<ResizeObserverCallback>();
        watchers.add(this.callback);
        resizeCallbacks.set(target, watchers);
    }
    unobserve(target: Element) {
        resizeCallbacks.get(target)?.delete(this.callback);
    }
    disconnect() {
        resizeCallbacks.forEach((watchers) => watchers.delete(this.callback));
    }
}

const nextFrame = () => act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

function reportResize(target: Element) {
    const entries = [{ target } as ResizeObserverEntry];
    const observer = {} as ResizeObserver;
    act(() => resizeCallbacks.get(target)?.forEach((callback) => callback(entries, observer)));
}

function fakeScroller(element: HTMLElement, clientHeight: number) {
    let scrollTop = 0;
    let scrollHeight = clientHeight;
    Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });
    return {
        scrollTo(top: number) {
            fireEvent.wheel(element);
            scrollTop = top;
            fireEvent.scroll(element);
        },
        // The transcript moving itself, with no reader behind it.
        driftTo(top: number) {
            scrollTop = top;
            fireEvent.scroll(element);
        },
        grow(height: number) {
            scrollHeight = height;
            const content = element.querySelector(".chat-scroll-content");
            if (content) reportResize(content);
            fireEvent.scroll(element);
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventListener = null;
    resizeCallbacks.clear();
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

/* The virtualizer keeps a row out of the DOM until the scroller has a size,
   and jsdom measures everything as nothing. */
async function openTranscript(): Promise<void> {
    render(<AgentChatPane agent={{ ...agent, model: "gpt-6-astra" }} cwd="/repo" active visible onBusyChange={() => {}} />);
    const editor = screen.getByRole("textbox", { name: "Message agent" });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Look at the styles" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    const scroller = document.querySelector(".chat-scroll") as HTMLElement;
    fakeScroller(scroller, 400);
    Object.defineProperty(scroller, "offsetWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(scroller, "offsetHeight", { configurable: true, get: () => 400 });
    reportResize(scroller);
    await screen.findByRole("status");
}

describe("AgentChatPane", () => {
    it("keeps receiving hidden session updates while freezing transcript rendering", async () => {
        const props = { agent, cwd: "/repo", active: true, visible: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        rerender(<AgentChatPane {...props} visible={false} />);
        emit("permission_request", {
            requestId: "hidden-request",
            sessionId: "session-1",
            toolCall: { toolCallId: "tool-1" },
            options: [{ optionId: "allow", name: "Allow hidden tool", kind: "allow_once" }],
        });
        expect(screen.queryByRole("button", { name: "Allow hidden tool" })).not.toBeInTheDocument();
        expect(acpApi.stop).not.toHaveBeenCalled();

        rerender(<AgentChatPane {...props} />);
        expect(await screen.findByRole("button", { name: "Allow hidden tool" })).toBeInTheDocument();
    });

    it("keeps the harness editable for a loaded session without messages", async () => {
        render(<AgentChatPane agent={{ ...agent, resumeId: "empty-session" }} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Agent" })).toBeEnabled());
        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Existing message" } },
        });
        emit("ready", { capabilities: {}, setup: {} });
        await waitFor(() => expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled());
    });

    it("changes the model live and persists only the confirmed configuration", async () => {
        const configs = (model: string) => [
            {
                id: "model",
                name: "Model",
                type: "select",
                currentValue: model,
                options: [
                    { value: "astra", name: "GPT-6 Astra" },
                    { value: "sol", name: "GPT-5.6 Sol" },
                ],
            },
            { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
        ];
        mocks.start.mockResolvedValueOnce({ sessionId: "session-1", capabilities: {}, setup: { configOptions: configs("astra") } });
        mocks.setConfig.mockResolvedValueOnce({ configOptions: configs("sol") });
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Model" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Model" }));
        fireEvent.change(screen.getByRole("combobox", { name: "Search model" }), { target: { value: "Sol" } });
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Search model" }), { key: "Enter" });
        await waitFor(() => expect(mocks.setConfig).toHaveBeenCalledWith(agent.id, "model", "sol"));
        await waitFor(() => expect(mocks.setAgentModelPreferences).toHaveBeenCalledWith(agent.id, "sol", "high"));
        expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6 Sol");
        expect(mocks.start).toHaveBeenCalledTimes(1);
        expect(acpApi.stop).not.toHaveBeenCalled();
    });

    it("attaches a new session when its first turn starts so metadata can update while it runs", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(screen.getByRole("textbox", { name: "Message agent" })).toBeEnabled());
        expect(mocks.attachAgentSession).not.toHaveBeenCalled();

        emit("turn_started", {});

        expect(mocks.attachAgentSession).toHaveBeenCalledWith(agent.id, "session-1");
    });

    it("changes YOLO on the live session without restarting", async () => {
        const props = { agent, cwd: "/repo", active: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} />);
        await waitFor(() => expect(screen.getByRole("textbox", { name: "Message agent" })).toBeEnabled());

        rerender(<AgentChatPane {...props} agent={{ ...agent, permissionMode: "bypass" }} />);
        await waitFor(() => expect(mocks.setPermissionMode).toHaveBeenCalledWith(agent.id, "bypass"));
        expect(mocks.start).toHaveBeenCalledTimes(1);
        expect(acpApi.stop).not.toHaveBeenCalled();
    });

    it("serializes rapid permission changes and applies the latest choice", async () => {
        let complete!: () => void;
        mocks.setPermissionMode.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                }),
        );
        const props = { agent, cwd: "/repo", active: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} />);
        await waitFor(() => expect(screen.getByRole("textbox", { name: "Message agent" })).toBeEnabled());
        rerender(<AgentChatPane {...props} agent={{ ...agent, permissionMode: "bypass" }} />);
        await waitFor(() => expect(complete).toBeDefined());
        rerender(<AgentChatPane {...props} />);
        await act(async () => complete());
        await waitFor(() => expect(mocks.setPermissionMode).toHaveBeenLastCalledWith(agent.id, "workspace-write"));
        expect(mocks.setPermissionMode).toHaveBeenCalledTimes(2);
        expect(mocks.start).toHaveBeenCalledTimes(1);
    });

    it("passes the configured executable, model and effort to ACP without restarting for equivalent profile arrays", async () => {
        const profile = {
            id: "custom",
            provider: "codex" as const,
            name: "Custom",
            accent: "#888888",
            executablePath: "/custom/codex",
            environmentKeys: ["CUSTOM_KEY"],
        };
        const props = { agent: { ...agent, model: "custom-model", effort: "high" as const }, cwd: "/repo", active: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} profile={profile} />);
        await waitFor(() =>
            expect(mocks.start).toHaveBeenCalledWith(
                expect.objectContaining({ executablePath: "/custom/codex", model: "custom-model", effort: "high" }),
            ),
        );
        rerender(<AgentChatPane {...props} profile={{ ...profile, environmentKeys: ["CUSTOM_KEY"] }} />);
        await act(async () => {});
        expect(mocks.start).toHaveBeenCalledTimes(1);
    });

    it("does not launch after a delayed subscription resolves on an unmounted pane", async () => {
        let subscribed!: () => void;
        vi.mocked(acpApi.subscribe).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    subscribed = () => resolve(() => {});
                }),
        );
        const { unmount } = render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(subscribed).toBeDefined());
        unmount();
        await act(async () => subscribed());
        expect(mocks.start).not.toHaveBeenCalled();
    });

    it("rolls back a rejected permission update and keeps the conversation connected", async () => {
        const props = { agent, cwd: "/repo", active: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} />);
        await waitFor(() => expect(screen.getByRole("textbox", { name: "Message agent" })).toBeEnabled());
        mocks.setPermissionMode.mockRejectedValueOnce(new Error("Mode unavailable"));
        rerender(<AgentChatPane {...props} agent={{ ...agent, permissionMode: "bypass" }} />);
        expect(await screen.findByText("Mode unavailable")).toBeInTheDocument();
        expect(mocks.setAgentPermissionMode).toHaveBeenCalledWith(agent.id, "workspace-write");
        expect(mocks.start).toHaveBeenCalledTimes(1);
    });

    it("blocks a second prompt while the first is waiting for turn_started", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        await waitFor(() => expect(editor).toBeEnabled());
        fireEvent.change(editor, { target: { value: "First" } });
        fireEvent.keyDown(editor, { key: "Enter" });
        fireEvent.change(editor, { target: { value: "Second" } });
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(mocks.prompt).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Stop agent" })).toBeInTheDocument();
    });

    it("puts a second message into the running turn when the agent takes steering", async () => {
        mocks.start.mockResolvedValueOnce({ sessionId: "session-1", capabilities: { steering: true }, setup: {} });
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        await waitFor(() => expect(editor).toBeEnabled());
        fireEvent.change(editor, { target: { value: "First" } });
        fireEvent.keyDown(editor, { key: "Enter" });
        fireEvent.change(editor, { target: { value: "Actually, check the other file" } });
        fireEvent.keyDown(editor, { key: "Enter" });

        await waitFor(() => expect(mocks.steer).toHaveBeenCalledWith(agent.id, "Actually, check the other file", []));
        expect(mocks.prompt).toHaveBeenCalledTimes(1);
    });

    it("sends as its own prompt when the turn ended before the steer arrived", async () => {
        mocks.start.mockResolvedValueOnce({ sessionId: "session-1", capabilities: { steering: true }, setup: {} });
        mocks.steer.mockResolvedValueOnce("promptRequired");
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        await waitFor(() => expect(editor).toBeEnabled());
        fireEvent.change(editor, { target: { value: "First" } });
        fireEvent.keyDown(editor, { key: "Enter" });
        fireEvent.change(editor, { target: { value: "Carry on" } });
        fireEvent.keyDown(editor, { key: "Enter" });

        await waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith(agent.id, "Carry on", []));
    });

    it("keeps saying the turn is alive, and names the tool it is running", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        await waitFor(() => expect(editor).toBeEnabled());
        fireEvent.change(editor, { target: { value: "Check the tests" } });
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(await screen.findByRole("status")).toHaveTextContent("Thinking…");

        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "mcp__github__list_issues", status: "in_progress" },
        });
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("list_issues"));

        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
        });
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Thinking…"));

        emit("turn_completed", { stopReason: "end_turn" });
        await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    });

    it("says what a running tool is doing instead of quoting the command it was given", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        await waitFor(() => expect(editor).toBeEnabled());
        fireEvent.change(editor, { target: { value: "Check the styles" } });
        fireEvent.keyDown(editor, { key: "Enter" });

        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-1",
                kind: "execute",
                title: 'grep -n "is-transparent" -A12 src/styles/base.css | head -40',
                status: "in_progress",
            },
        });
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running a command…"));
        expect(screen.getByRole("status")).not.toHaveTextContent("is-transparent");
    });

    it("folds a run of tool calls away once it finishes, and leaves reasoning in plain sight", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Weighing the two options" } },
        });
        for (const toolCallId of ["tool-1", "tool-2"]) {
            emit("session_update", {
                sessionId: "session-1",
                update: { sessionUpdate: "tool_call", toolCallId, kind: "read", title: "src/styles/chat.css", status: "in_progress" },
            });
        }

        expect(await screen.findByText("Weighing the two options")).toBeVisible();
        const run = await screen.findByRole("button", { name: /2 tool calls/ });
        expect(run).toHaveAttribute("aria-expanded", "true");

        for (const toolCallId of ["tool-1", "tool-2"]) {
            emit("session_update", {
                sessionId: "session-1",
                update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
            });
        }
        await waitFor(() => expect(run).toHaveAttribute("aria-expanded", "false"));
        expect(document.querySelectorAll(".chat-tool")).toHaveLength(0);

        fireEvent.click(run);
        expect(run).toHaveAttribute("aria-expanded", "true");
        expect(document.querySelectorAll(".chat-tool")).toHaveLength(2);
    });

    it("hangs each call off the run as a kind, a target and how long it took", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-1",
                kind: "execute",
                title: "pnpm vitest run src/lib/shaderField.test.ts",
                status: "in_progress",
            },
        });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-2",
                kind: "read",
                title: "src/components/browser/BrowserPane.tsx",
                status: "completed",
            },
        });

        const rows = await screen.findAllByTitle(/shaderField|BrowserPane/);
        expect(rows[0]).toHaveTextContent("run");
        expect(rows[0]).toHaveTextContent("pnpm vitest run src/lib/shaderField.test.ts");
        // A path shows the name it ends in; the whole path stays in the tooltip.
        expect(rows[1]).toHaveTextContent("BrowserPane.tsx");
        expect(rows[1]).not.toHaveTextContent("src/components");
        expect(rows[1]).toHaveAttribute("title", "src/components/browser/BrowserPane.tsx");
    });

    it("opens an edit onto the hunk it wrote, and a failure onto why", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-1",
                kind: "edit",
                title: "src/styles/stage.css",
                status: "completed",
                content: [
                    {
                        type: "diff",
                        path: "src/styles/stage.css",
                        oldText: ".stage {\n    background: var(--pane);\n}\n",
                        newText: ".stage {\n    background: transparent;\n}\n",
                    },
                ],
            },
        });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-2",
                kind: "execute",
                title: "pnpm vitest run",
                status: "failed",
                rawOutput: { output: "1 failed · expected rgba(26,22,36,.72)" },
            },
        });

        fireEvent.click(await screen.findByRole("button", { name: /2 tool calls/ }));
        const edit = await screen.findByTitle("src/styles/stage.css");
        expect(edit).toHaveTextContent("+1");
        expect(edit).toHaveTextContent("−1");
        expect(screen.queryByText(/background: transparent;/)).not.toBeInTheDocument();

        fireEvent.click(edit);
        const added = await waitFor(() => document.querySelector(".chat-diff-line.add") as HTMLElement);
        expect(added).toHaveTextContent("background: transparent;");
        // Only the part that changed is marked, not the whole line.
        expect(added.querySelector("mark")).toHaveTextContent("transparent");
        expect(document.querySelector(".chat-diff-line.del")).toHaveTextContent("background: var(--pane);");

        fireEvent.click(screen.getByTitle("pnpm vitest run"));
        expect(await screen.findByText(/1 failed/)).toBeInTheDocument();
    });

    it("names an mcp call for the server it went to, and gives the column room for it", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "mcp__atlassian__addCommentToJiraIssue", status: "in_progress" },
        });

        const row = await screen.findByTitle("mcp__atlassian__addCommentToJiraIssue");
        expect(row).toHaveTextContent("atlassian");
        expect(row).toHaveTextContent("addCommentToJiraIssue");
        expect(row).toHaveAttribute("data-kind", "mcp");
        expect((document.querySelector(".chat-tools-body") as HTMLElement).style.getPropertyValue("--chat-kind")).toBe("9ch");
    });

    it("rules a table the agent wrote, and lets a wide one scroll on its own", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "| approach | cpu |\n| --- | --- |\n| ack every frame | 90.6% |\n" },
            },
        });

        const cell = await screen.findByText("ack every frame");
        expect(cell.tagName).toBe("TD");
        expect(screen.getByText("approach").tagName).toBe("TH");
        expect(cell.closest(".chat-table")).not.toBeNull();
    });

    it("colours a patch the agent wrote in a fence, and leaves ordinary output alone", async () => {
        await openTranscript();
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                    type: "text",
                    text: "```\n .stage {\n-    background: var(--pane);\n+    background: transparent;\n }\n```\n\n```\n900x600 ok\n1024x600 FLOOD\n```\n",
                },
            },
        });

        await waitFor(() => expect(document.querySelector(".chat-code-diff")).not.toBeNull());
        expect(document.querySelector(".chat-code-diff .chat-diff-line.del")).toHaveTextContent("background: var(--pane);");
        expect(document.querySelector(".chat-code-diff .chat-diff-line.add mark")).toHaveTextContent("transparent");
        // The block of measurements beside it is not a patch and keeps its own shape.
        expect(document.querySelectorAll(".chat-code-diff")).toHaveLength(1);
    });

    it("shows adapter progress and retries failed startup", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());

        emit("status", { state: "installing" });
        expect(screen.getAllByText("Installing structured-session adapter…")[0]).toBeInTheDocument();
        emit("error", { message: "adapter failed" });
        const callsBeforeRetry = mocks.start.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(mocks.start.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
    });

    it("shows permission requests even when the adapter omits the optional tool title", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("permission_request", {
            requestId: "request-1",
            sessionId: "session-1",
            toolCall: { toolCallId: "tool-1" },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
        });
        fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
        await waitFor(() => expect(acpApi.permissionReply).toHaveBeenCalledWith(agent.id, "request-1", "allow"));
    });

    it("lists a background task until it ends, and stops it on request", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "async_task_spawned",
                asyncTaskId: "task-1",
                name: "pnpm test",
                taskType: "shell",
                description: "Run the suite",
                canStop: true,
            },
        });
        expect(await screen.findByRole("button", { name: "Stop pnpm test" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Stop pnpm test" }));
        await waitFor(() => expect(mocks.stopTask).toHaveBeenCalledWith("agent-1", "task-1"));

        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "async_task_state_update", asyncTaskId: "task-1", state: "stopped" },
        });
        await waitFor(() => expect(screen.queryByText("pnpm test")).not.toBeInTheDocument());
    });

    it("shows ACP slash commands and inserts the selected command", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "compact", description: "Compact context", input: { hint: "focus" } }],
            },
        });
        await act(async () => window.requestAnimationFrame(() => {}));

        const editor = screen.getByRole("textbox", { name: "Message agent" });
        fireEvent.change(editor, { target: { value: "/" } });
        expect(await screen.findByRole("option", { name: /compact/i })).toBeInTheDocument();
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor).toHaveValue("/compact ");
    });

    it("offers commands for a slash typed part-way through a draft", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "compact", description: "Compact context", input: { hint: "focus" } }],
            },
        });
        await act(async () => window.requestAnimationFrame(() => {}));

        const editor = screen.getByRole("textbox", { name: "Message agent" });
        fireEvent.change(editor, { target: { value: "tidy up then /comp", selectionStart: 18 } });
        expect(await screen.findByRole("option", { name: /compact/i })).toBeInTheDocument();
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor).toHaveValue("tidy up then /compact ");
    });

    it("leaves what follows the caret in place when a command is chosen", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "compact", description: "Compact context", input: { hint: "focus" } }],
            },
        });
        await act(async () => window.requestAnimationFrame(() => {}));

        const editor = screen.getByRole("textbox", { name: "Message agent" });
        fireEvent.change(editor, { target: { value: "run /comp then stop", selectionStart: 9 } });
        expect(await screen.findByRole("option", { name: /compact/i })).toBeInTheDocument();
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor).toHaveValue("run /compact then stop");
    });

    it("keeps a slash inside a word from opening the command menu", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });
        emit("session_update", {
            sessionId: "session-1",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{ name: "compact", description: "Compact context", input: { hint: "focus" } }],
            },
        });
        await act(async () => window.requestAnimationFrame(() => {}));

        const editor = screen.getByRole("textbox", { name: "Message agent" });
        fireEvent.change(editor, { target: { value: "src/comp", selectionStart: 8 } });
        await act(async () => window.requestAnimationFrame(() => {}));
        expect(screen.queryByRole("option", { name: /compact/i })).not.toBeInTheDocument();
    });

    it("stays pinned while a restored transcript settles, and lets go when the reader scrolls up", async () => {
        render(<AgentChatPane agent={{ ...agent, resumeId: "old-session" }} cwd="/repo" active visible onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("session_update", {
            sessionId: "session-1",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } },
        });
        emit("ready", { capabilities: {}, setup: {} });

        const scroller = document.querySelector(".chat-scroll") as HTMLElement;
        const view = fakeScroller(scroller, 400);
        view.scrollTo(600);
        expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();

        // Rows measuring taller than their estimate push the bottom away. The
        // reader has not moved, so the transcript must not come unstuck.
        view.grow(3000);
        expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();
        expect(scroller.scrollTop).toBe(2600);

        // Settling also moves the scroller itself, which must not read as the
        // reader leaving — that left old sessions stranded mid-transcript.
        view.driftTo(2200);
        expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();
        view.grow(3600);
        expect(scroller.scrollTop).toBe(3200);

        view.scrollTo(200);
        expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
    });

    it("focuses the composer once a chat connects, and again when a hidden one is reopened", async () => {
        const props = { agent, cwd: "/repo", active: true, onBusyChange: () => {} };
        const { rerender } = render(<AgentChatPane {...props} visible />);
        const editor = screen.getByRole("textbox", { name: "Message agent" });
        expect(editor).toBeDisabled();

        await waitFor(() => expect(editor).toBeEnabled());
        await nextFrame();
        expect(editor).toHaveFocus();

        rerender(<AgentChatPane {...props} visible={false} />);
        act(() => editor.blur());
        rerender(<AgentChatPane {...props} visible />);
        await nextFrame();
        expect(editor).toHaveFocus();
    });

    it("leaves a field being typed in alone when a chat connects behind it", async () => {
        const elsewhere = document.createElement("input");
        document.body.append(elsewhere);
        elsewhere.focus();
        render(<AgentChatPane agent={agent} cwd="/repo" active visible onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());

        emit("ready", { capabilities: {}, setup: {} });
        await nextFrame();
        expect(elsewhere).toHaveFocus();
        elsewhere.remove();
    });

    it("routes native path drops into prompt attachments", async () => {
        render(<AgentChatPane agent={agent} cwd="/repo" active profile={undefined} onBusyChange={() => {}} />);
        await waitFor(() => expect(mocks.eventListener).not.toBeNull());
        emit("ready", { capabilities: {}, setup: {} });

        const editor = screen.getByRole("textbox", { name: "Message agent" });
        expect(dispatchPathDrop(editor, ["/repo/src/App.tsx"])).toBe(true);
        expect(await screen.findByText("App.tsx")).toBeInTheDocument();

        fireEvent.change(editor, { target: { value: "Review this" } });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith(agent.id, "Review this", ["/repo/src/App.tsx"]));
    });
});
