import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStatus } from "../api/remote";
import { installIpcTransportForTests, MemoryIpcTransport, resetIpcTransportForTests } from "../api/transport";
import * as cmd from "../state/commands";
import { getState, setState } from "../state/store";
import { PUBLISH_DELAY_MS, RemoteWorkspaceBridge } from "./RemoteWorkspaceBridge";

const initial = getState();

function status(enabled: boolean): RemoteStatus {
    return {
        enabled,
        coreId: "core",
        addresses: [],
        devices: [],
        connected: [],
        pairing: null,
        pending: [],
        owner: null,
        account: null,
        updateRequired: null,
        notifications: [],
    };
}

let transport: MemoryIpcTransport;
let publish: ReturnType<typeof vi.fn<(args: unknown) => void>>;

beforeEach(() => {
    vi.useFakeTimers();
    setState(initial, true);
    transport = new MemoryIpcTransport();
    installIpcTransportForTests(transport);
    publish = vi.fn<(args: unknown) => void>();
    transport.register("remote_publish_workspace", publish);
});

afterEach(() => {
    cleanup();
    resetIpcTransportForTests();
    vi.useRealTimers();
});

async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(PUBLISH_DELAY_MS + 50);
    });
}

describe("RemoteWorkspaceBridge", () => {
    it("publishes the workspace with remote access off, and again when a project opens", async () => {
        transport.register("remote_status", () => status(false));
        render(<RemoteWorkspaceBridge />);
        await settle();
        expect(publish).toHaveBeenCalledTimes(1);
        const before = publish.mock.calls[0][0] as { projects: { path: string }[] };

        act(() => {
            cmd.createProjectSession("/Users/me/new-project");
        });
        await settle();
        expect(publish).toHaveBeenCalledTimes(2);
        const after = publish.mock.calls[1][0] as { projects: { path: string }[]; launchers: { id: string }[] };
        expect(after.projects.length).toBe(before.projects.length + 1);
        expect(after.projects.map((project) => project.path)).toContain("/Users/me/new-project");
        expect(after.launchers.map((launcher) => launcher.id)).toContain("opencode");
    });

    it("publishes what the person named their agents and which one is on screen", async () => {
        transport.register("remote_status", () => status(false));
        const agents = vi.fn<(args: unknown) => void>();
        const onScreen = vi.fn<(args: unknown) => void>();
        transport.register("remote_publish_agents", agents);
        transport.register("remote_publish_on_screen", onScreen);
        render(<RemoteWorkspaceBridge />);
        await settle();
        act(() => {
            cmd.createProjectSession("/Users/me/notch");
            cmd.addAgent("claude", undefined, "Fix the login flake");
        });
        await settle();
        const agentId = Object.values(getState().agents).find((agent) => agent.title === "Fix the login flake")?.id ?? "";
        const titles = (agents.mock.lastCall?.[0] as { titles: Record<string, string> }).titles;
        expect(titles[agentId]).toBe("Fix the login flake");
        expect(onScreen.mock.lastCall?.[0]).toEqual({ agentIds: [agentId] });
    });
});
