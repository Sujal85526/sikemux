import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { PtyContext } from "../state/types";
import { disposeWorkbenchItemResources, resetWorkbenchItemRuntimeForTests } from "../workbench/itemRuntime";
import { createItemId } from "../workbench/registry";
import { usePty } from "./usePty";

const { invoke } = vi.hoisted(() => ({
    invoke: vi.fn(async (command: string) => (command === "pty_spawn" ? 42 : null)),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(async () => {
    cleanup();
    await resetWorkbenchItemRuntimeForTests();
    invoke.mockClear();
});

function Harness({
    context,
    initialInput,
    onInitialInputDelivered,
    durable = false,
}: {
    context: PtyContext;
    initialInput?: string;
    onInitialInputDelivered?: () => void;
    durable?: boolean;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    usePty({
        cwd: "/repo",
        startup: "codex",
        initialInput,
        onInitialInputDelivered,
        hostRef,
        context,
        durableItemId: durable ? context.paneId : undefined,
    });
    return <div ref={hostRef} />;
}

describe("usePty", () => {
    it("sends the complete typed terminal identity to the backend", async () => {
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
            windowId: "window-1",
            paneId: "pane-1",
            agentId: "agent-1",
            agentType: "codex",
        };

        render(<Harness context={context} />);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("pty_spawn", {
                cols: 80,
                rows: 24,
                cwd: "/repo",
                startup: "codex",
                context,
            });
        });
    });

    it("bracket-pastes and submits a provider fallback first message exactly once", async () => {
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
            agentId: "agent-1",
            agentType: "hermes",
            initialPromptSubmitted: false,
        };

        const onInitialInputDelivered = vi.fn();
        render(<Harness context={context} initialInput="Build it safely." onInitialInputDelivered={onInitialInputDelivered} />);

        await waitFor(
            () => {
                expect(invoke).toHaveBeenCalledWith("pty_write", {
                    id: 42,
                    data: "\x1b[200~Build it safely.\x1b[201~\r",
                });
            },
            { timeout: 1_500 },
        );
        expect(invoke.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);
        expect(onInitialInputDelivered).toHaveBeenCalledOnce();
    });

    it("keeps a pane PTY alive across renderer remounts until item disposal", async () => {
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
            windowId: "window-1",
            paneId: "pane-durable",
        };
        const first = render(<Harness context={context} durable />);
        await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "pty_spawn")).toHaveLength(1));
        first.unmount();
        expect(invoke.mock.calls.some(([command]) => command === "pty_kill")).toBe(false);

        const second = render(<Harness context={context} durable />);
        await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "pty_spawn")).toHaveLength(1));
        second.unmount();
        await disposeWorkbenchItemResources(createItemId(context.paneId!));
        expect(invoke.mock.calls.filter(([command]) => command === "pty_kill")).toHaveLength(1);
    });
});
