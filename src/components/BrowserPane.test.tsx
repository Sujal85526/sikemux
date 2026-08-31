import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi, type BrowserSnapshot } from "../api/browser";
import { AgentBrowserShell } from "./BrowserPane";

vi.mock("../api/browser", async () => {
    const actual = await vi.importActual<typeof import("../api/browser")>("../api/browser");
    return {
        ...actual,
        browserApi: {
            snapshot: vi.fn(),
            newTab: vi.fn(),
            switchTab: vi.fn(),
            closeTab: vi.fn(),
            navigate: vi.fn(),
            back: vi.fn(),
            forward: vi.fn(),
            reload: vi.fn(),
            pointer: vi.fn(),
            key: vi.fn(),
        },
    };
});

const snapshot: BrowserSnapshot = {
    tabs: [{ id: "tab-one", title: "Example", url: "https://example.com", active: true }],
    activeTabId: "tab-one",
    frame: "aGVsbG8=",
    cursor: null,
    viewportWidth: 960,
    viewportHeight: 640,
};

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.mocked(browserApi.snapshot).mockResolvedValue(snapshot);
    for (const operation of [
        browserApi.newTab,
        browserApi.switchTab,
        browserApi.closeTab,
        browserApi.navigate,
        browserApi.back,
        browserApi.forward,
        browserApi.reload,
        browserApi.pointer,
        browserApi.key,
    ]) {
        vi.mocked(operation).mockResolvedValue(undefined as never);
    }
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("AgentBrowserShell", () => {
    it("opens the right-side browser when native tabs appear and routes user tab actions", async () => {
        render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );

        expect(screen.getByText("terminal")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole("tab", { name: "Example" })).toBeInTheDocument());
        expect(screen.getByRole("region", { name: "codex browser" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /New browser tab/ }));
        expect(browserApi.newTab).toHaveBeenCalledWith("agent-one");

        const address = screen.getByRole("textbox", { name: "Address and search" });
        fireEvent.change(address, { target: { value: "openai.com" } });
        fireEvent.submit(address.closest("form")!);
        expect(browserApi.navigate).toHaveBeenCalledWith("agent-one", "openai.com");
    });
});
