import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { performanceTelemetry } from "../lib/performance";
import { dispatchPty } from "../state/dropRegistry";
import type { PtyContext } from "../state/types";
import { disposeWorkbenchItemResources, resetWorkbenchItemRuntimeForTests } from "../workbench/itemRuntime";
import { createItemId } from "../workbench/registry";
import { encodePosixShellLiteral, encodePowerShellLiteral, shellSemanticsForExecutable, usePty } from "./usePty";

const { invoke } = vi.hoisted(() => ({
    invoke: vi.fn(async (command: string) => {
        if (command === "pty_spawn") return 42;
        if (command === "integration_health") return { shell: "/bin/zsh" };
        return null;
    }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(async () => {
    cleanup();
    await resetWorkbenchItemRuntimeForTests();
    vi.restoreAllMocks();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
        if (command === "pty_spawn") return 42;
        if (command === "integration_health") return { shell: "/bin/zsh" };
        return null;
    });
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

describe("terminal path literal encoding", () => {
    it("preserves POSIX metacharacters inside a single-quoted literal", () => {
        const path = "-literal path\n$(touch nope)`whoami`;pipe|glob*?[x]>out<in\\slash'quote";

        expect(encodePosixShellLiteral(path)).toBe("'-literal path\n$(touch nope)`whoami`;pipe|glob*?[x]>out<in\\slash'\\''quote'");
    });

    it("preserves PowerShell metacharacters and doubles embedded single quotes", () => {
        const path = "C:\\O'Brien\\-literal path\n$env:TEMP\\$(x)`x;pipe|glob*?>out<in";

        expect(encodePowerShellLiteral(path)).toBe("'C:\\O''Brien\\-literal path\n$env:TEMP\\$(x)`x;pipe|glob*?>out<in'");
    });

    it("rejects NUL in both shell encoders", () => {
        expect(() => encodePosixShellLiteral("safe\0unsafe")).toThrow(/NUL/);
        expect(() => encodePowerShellLiteral("safe\0unsafe")).toThrow(/NUL/);
    });

    it("selects semantics from the configured executable rather than its host platform", () => {
        expect(shellSemanticsForExecutable("/bin/zsh")).toBe("posix");
        expect(shellSemanticsForExecutable("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix");
        expect(shellSemanticsForExecutable('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"')).toBe("powershell");
        expect(shellSemanticsForExecutable("/opt/microsoft/powershell/7/PWSH")).toBe("powershell");
        expect(shellSemanticsForExecutable("/bin/custom-shell")).toBeNull();
    });
});

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

    it("quotes every dropped path with the semantics of the configured POSIX shell", async () => {
        invoke.mockImplementation(async (command: string) => {
            if (command === "pty_spawn") return 42;
            if (command === "integration_health") return { shell: "C:\\Program Files\\Git\\bin\\bash.exe" };
            return null;
        });
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
        };
        const view = render(<Harness context={context} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.anything()));

        const host = view.container.firstElementChild as HTMLElement;
        expect(dispatchPty(host, ["/tmp/a b", "/tmp/O'Brien", "-$(touch nope);|*?>\nfile"])).toBe(true);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("pty_write", {
                id: 42,
                data: "\x1b[200~'/tmp/a b' '/tmp/O'\\''Brien' '-$(touch nope);|*?>\nfile'\x1b[201~",
            });
        });
    });

    it("uses PowerShell literal rules when the configured shell is pwsh", async () => {
        invoke.mockImplementation(async (command: string) => {
            if (command === "pty_spawn") return 42;
            if (command === "integration_health") return { shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" };
            return null;
        });
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
        };
        const view = render(<Harness context={context} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.anything()));

        const host = view.container.firstElementChild as HTMLElement;
        expect(dispatchPty(host, ["C:\\O'Brien and $(touch nope);|*?>\nfile"])).toBe(true);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("pty_write", {
                id: 42,
                data: "\x1b[200~'C:\\O''Brien and $(touch nope);|*?>\nfile'\x1b[201~",
            });
        });
    });

    it("rejects the whole drop when any path contains NUL", async () => {
        const rejected = vi.spyOn(performanceTelemetry, "incrementCounter");
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
        };
        const view = render(<Harness context={context} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.anything()));

        const host = view.container.firstElementChild as HTMLElement;
        expect(dispatchPty(host, ["/tmp/safe", "/tmp/unsafe\0suffix"])).toBe(true);

        expect(invoke.mock.calls.some(([command]) => command === "integration_health")).toBe(false);
        expect(invoke.mock.calls.some(([command]) => command === "pty_write")).toBe(false);
        expect(rejected.mock.calls.filter(([name]) => name === "terminal.drop.rejected.nul")).toHaveLength(1);
    });

    it("reports a failed drop write exactly once", async () => {
        const writeError = new Error("write failed");
        invoke.mockImplementation(async (command: string) => {
            if (command === "pty_spawn") return 42;
            if (command === "integration_health") return { shell: "/bin/zsh" };
            if (command === "pty_write") throw writeError;
            return null;
        });
        const errors = vi.spyOn(performanceTelemetry, "incrementCounter");
        const context: PtyContext = {
            sessionId: "session-1",
            sessionName: "repo",
            sessionKind: "project",
            project: "/repo",
        };
        const view = render(<Harness context={context} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.anything()));

        const host = view.container.firstElementChild as HTMLElement;
        expect(dispatchPty(host, ["/tmp/file"])).toBe(true);
        await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "pty_write")).toBe(true));
        await Promise.resolve();
        await Promise.resolve();

        expect(errors.mock.calls.filter(([name]) => name === "terminal.controller.errors.write")).toHaveLength(1);
    });
});
