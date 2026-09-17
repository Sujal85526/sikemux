import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi, type BrowserFrame, type BrowserSnapshot } from "../api/browser";
import { useToasts } from "../state/toast";
import { AgentBrowserShell } from "./BrowserPane";

vi.mock("../api/browser", async () => {
    const actual = await vi.importActual<typeof import("../api/browser")>("../api/browser");
    return {
        ...actual,
        browserApi: {
            snapshot: vi.fn(),
            startFrames: vi.fn(),
            newTab: vi.fn(),
            closeAgent: vi.fn(),
            switchTab: vi.fn(),
            closeTab: vi.fn(),
            navigate: vi.fn(),
            back: vi.fn(),
            forward: vi.fn(),
            reload: vi.fn(),
            pointer: vi.fn(),
            key: vi.fn(),
            respondDialog: vi.fn(),
            subscribeTabs: vi.fn(),
        },
    };
});

const snapshot: BrowserSnapshot = {
    tabs: [{ id: "tab-one", title: "Example", url: "https://example.com", active: true }],
    activeTabId: "tab-one",
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
    vi.mocked(browserApi.subscribeTabs).mockResolvedValue(vi.fn());
    vi.mocked(browserApi.startFrames).mockImplementation(async (_agent, _target, _viewport, onFrame) => {
        onFrame({ data: "aGVsbG8=", width: 960, height: 640 });
        return vi.fn().mockResolvedValue(undefined);
    });
    for (const operation of [
        browserApi.newTab,
        browserApi.closeAgent,
        browserApi.switchTab,
        browserApi.closeTab,
        browserApi.navigate,
        browserApi.back,
        browserApi.forward,
        browserApi.reload,
        browserApi.pointer,
        browserApi.key,
        browserApi.respondDialog,
    ]) {
        vi.mocked(operation).mockResolvedValue(undefined as never);
    }
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    useToasts.setState({ toasts: [] });
});

async function renderStreamingPane() {
    const { container } = render(
        <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
            <div>terminal</div>
        </AgentBrowserShell>,
    );
    await waitFor(() => expect(container.querySelector(".browser-viewport > img[src]")).not.toBeNull());
    const viewport = container.querySelector<HTMLElement>(".browser-viewport")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 480, height: 320 } as DOMRect);
    return viewport;
}

describe("AgentBrowserShell", () => {
    it("opens the right-side browser when native tabs appear and routes user tab actions", async () => {
        const { container } = render(
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

        await waitFor(() => expect(container.querySelector(".browser-viewport > img[src]")).not.toBeNull());
        const viewport = container.querySelector(".browser-viewport")!;
        vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 480, height: 320 } as DOMRect);
        fireEvent.pointerMove(viewport, { clientX: 120, clientY: 80 });
        expect(browserApi.pointer).toHaveBeenCalledWith("agent-one", expect.objectContaining({ kind: "move", x: 240, y: 160 }));
    });

    /*
     * The pane used to find out about a new tab only on its next poll, which
     * put most of a second between the agent opening a page and it showing up.
     * Chromium now says so itself and the pane reads on being told.
     */
    it("shows a tab as soon as the browser reports one, without waiting for a poll", async () => {
        let announce = () => {};
        vi.mocked(browserApi.subscribeTabs).mockImplementation(async (listener) => {
            announce = listener;
            return vi.fn<() => void>();
        });
        vi.mocked(browserApi.snapshot).mockResolvedValue({ tabs: [], activeTabId: null });
        render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(browserApi.subscribeTabs).toHaveBeenCalled());
        expect(screen.queryByRole("region", { name: "codex browser" })).toBeNull();

        vi.mocked(browserApi.snapshot).mockResolvedValue(snapshot);
        await act(async () => {
            announce();
        });

        expect(screen.getByRole("region", { name: "codex browser" })).toBeInTheDocument();
    });

    /* A loading page reports itself several times; each one must not stack up
       another read on top of the one already running. */
    it("collapses a burst of tab reports into one read and a follow-up", async () => {
        let announce = () => {};
        vi.mocked(browserApi.subscribeTabs).mockImplementation(async (listener) => {
            announce = listener;
            return vi.fn<() => void>();
        });
        let release: (() => void) | undefined;
        vi.mocked(browserApi.snapshot).mockImplementation(() => new Promise((resolve) => (release = () => resolve(snapshot))));
        render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(release).toBeDefined());
        expect(browserApi.snapshot).toHaveBeenCalledOnce();

        await act(async () => {
            announce();
            announce();
            announce();
            release!();
        });

        expect(browserApi.snapshot).toHaveBeenCalledTimes(2);
    });

    /*
     * The strip used to be hand-rolled markup with no key handling at all, so
     * arrowing between browser tabs did nothing. Sharing TabBar is what gives it
     * the same roving focus every other strip has.
     */
    it("walks browser tabs with the arrow keys", async () => {
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            tabs: [
                { id: "tab-one", title: "Example", url: "https://example.com", active: true },
                { id: "tab-two", title: "Second", url: "https://second.test", active: false },
            ],
            activeTabId: "tab-one",
        });
        render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div />
            </AgentBrowserShell>,
        );

        const first = await screen.findByRole("tab", { name: /Example/ });
        fireEvent.keyDown(first, { key: "ArrowRight" });

        await waitFor(() => expect(browserApi.switchTab).toHaveBeenCalledWith("agent-one", "tab-two"));
    });

    it("stops hidden streams and ignores frames delivered after cleanup", async () => {
        const stop = vi.fn().mockResolvedValue(undefined);
        let receive: (frame: BrowserFrame) => void = () => {};
        vi.mocked(browserApi.startFrames).mockImplementation(async (_agent, _target, _viewport, onFrame) => {
            receive = onFrame;
            onFrame({ data: "first", width: 960, height: 640 });
            return stop;
        });
        const { container, rerender } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("first"));
        rerender(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible={false}>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(stop).toHaveBeenCalledOnce());
        act(() => receive({ data: "stale", width: 960, height: 640 }));
        expect(container.querySelector("img")?.getAttribute("src")).toBeNull();
    });

    it("stops a stream whose startup completes after the pane unmounts", async () => {
        const stop = vi.fn().mockResolvedValue(undefined);
        let finish: (stop: () => Promise<void>) => void = () => {};
        vi.mocked(browserApi.startFrames).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { unmount } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(browserApi.startFrames).toHaveBeenCalledOnce());
        unmount();
        await act(async () => finish(stop));
        expect(stop).toHaveBeenCalledOnce();
    });

    it("replaces the frame stream when switching tabs without reusing the old image", async () => {
        const stop = vi.fn().mockResolvedValue(undefined);
        const callbacks: Array<(frame: BrowserFrame) => void> = [];
        vi.mocked(browserApi.startFrames).mockImplementation(async (_agent, target, _viewport, onFrame) => {
            callbacks.push(onFrame);
            onFrame({ data: target, width: 960, height: 640 });
            return stop;
        });
        const { container } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("tab-one"));
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            tabs: [{ id: "tab-two", title: "Second", url: "https://example.org", active: true }],
            activeTabId: "tab-two",
        });
        fireEvent.click(screen.getByRole("button", { name: /New browser tab/ }));
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("tab-two"));
        expect(stop).toHaveBeenCalledOnce();
        act(() => callbacks[0]({ data: "stale", width: 960, height: 640 }));
        expect(container.querySelector("img")?.getAttribute("src")).toContain("tab-two");
    });

    it("renders a themed native surface instead of Chromium's white blank frame", async () => {
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            ...snapshot,
            tabs: [{ id: "blank-tab", title: "", url: "about:blank", active: true }],
            activeTabId: "blank-tab",
        });
        const { container } = render(
            <AgentBrowserShell agentId="agent-one" agentType="claude" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );

        await waitFor(() => expect(screen.getByLabelText("Blank browser page")).toBeInTheDocument());
        expect(container.querySelector(".browser-viewport > img[src]")).toBeNull();
        const viewport = container.querySelector(".browser-viewport")!;
        fireEvent.pointerMove(viewport, { clientX: 12, clientY: 18 });
        fireEvent.pointerDown(viewport, { clientX: 12, clientY: 18 });
        fireEvent.wheel(viewport, { deltaY: 100 });
        expect(browserApi.pointer).not.toHaveBeenCalled();
    });

    /*
     * Modifier chords used to be dropped on the floor, so Command+A ran the host
     * webview's own select-all over the sikemux UI instead of the page.
     */
    it("hands modifier chords and editing keys to the page", async () => {
        const { container } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(container.querySelector(".browser-viewport > img[src]")).not.toBeNull());
        const viewport = container.querySelector(".browser-viewport")!;

        const selectAll = fireEvent.keyDown(viewport, { key: "a", code: "KeyA", metaKey: true });
        const backspace = fireEvent.keyDown(viewport, { key: "Backspace", code: "Backspace" });

        expect(selectAll).toBe(false);
        expect(backspace).toBe(false);
        await waitFor(() => expect(browserApi.key).toHaveBeenCalledWith("agent-one", { kind: "down", key: "a", code: "KeyA", modifiers: 4 }));
        expect(browserApi.key).toHaveBeenCalledWith("agent-one", { kind: "down", key: "Backspace", code: "Backspace", modifiers: 0 });
    });

    it("inserts plain characters as text and leaves them without a key release", async () => {
        const { container } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(container.querySelector(".browser-viewport > img[src]")).not.toBeNull());
        const viewport = container.querySelector(".browser-viewport")!;

        fireEvent.keyDown(viewport, { key: "j", code: "KeyJ" });
        fireEvent.keyUp(viewport, { key: "j", code: "KeyJ" });

        await waitFor(() => expect(browserApi.key).toHaveBeenCalledWith("agent-one", { kind: "text", key: "j", code: "KeyJ", text: "j" }));
        expect(browserApi.key).toHaveBeenCalledOnce();
    });

    it("captures pointer drags and releases Chromium on cancellation", async () => {
        const { container } = render(
            <AgentBrowserShell agentId="agent-one" agentType="codex" visible>
                <div>terminal</div>
            </AgentBrowserShell>,
        );
        await waitFor(() => expect(container.querySelector(".browser-viewport > img[src]")).not.toBeNull());
        const viewport = container.querySelector<HTMLElement>(".browser-viewport")!;
        const capture = vi.fn();
        const release = vi.fn();
        Object.defineProperties(viewport, {
            setPointerCapture: { value: capture },
            hasPointerCapture: { value: () => true },
            releasePointerCapture: { value: release },
        });

        fireEvent.pointerDown(viewport, { pointerId: 7, clientX: 12, clientY: 18 });
        fireEvent.pointerCancel(viewport, { pointerId: 7, clientX: 20, clientY: 24 });

        expect(capture).toHaveBeenCalledWith(7);
        expect(release).toHaveBeenCalledWith(7);
        expect(browserApi.pointer).toHaveBeenCalledWith("agent-one", expect.objectContaining({ kind: "down" }));
        expect(browserApi.pointer).toHaveBeenCalledWith("agent-one", expect.objectContaining({ kind: "up" }));
    });

    /*
     * Headless Chromium draws nothing for a page's alert/confirm/prompt and
     * freezes the page until it is answered, so every click used to hang for
     * 15 seconds and land as a toast. The pane now shows the dialog itself.
     */
    it("shows a page's dialog in the pane, keeps input off the page, and sends the answer", async () => {
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            tabs: [{ ...snapshot.tabs[0], dialog: { kind: "confirm", message: "Sure?", defaultPrompt: "", url: "https://example.com/ask" } }],
            activeTabId: "tab-one",
        });
        const viewport = await renderStreamingPane();
        const sheet = screen.getByRole("dialog", { name: "example.com says" });
        expect(sheet).toHaveTextContent("Sure?");

        fireEvent.pointerDown(viewport, { clientX: 12, clientY: 18 });
        fireEvent.keyDown(viewport, { key: "a", code: "KeyA" });
        expect(browserApi.pointer).not.toHaveBeenCalled();
        expect(browserApi.key).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "OK" }));
        expect(browserApi.respondDialog).toHaveBeenCalledWith("agent-one", "tab-one", true, undefined);
    });

    it("answers a prompt with the typed text and a cancel with a refusal", async () => {
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            tabs: [{ ...snapshot.tabs[0], dialog: { kind: "prompt", message: "Name?", defaultPrompt: "anon", url: "https://example.com/" } }],
            activeTabId: "tab-one",
        });
        await renderStreamingPane();
        const input = screen.getByRole("textbox", { name: "Prompt answer" });
        expect(input).toHaveValue("anon");
        expect(input).toHaveFocus();
        fireEvent.change(input, { target: { value: "kishore" } });
        fireEvent.submit(input.closest("form")!);
        expect(browserApi.respondDialog).toHaveBeenCalledWith("agent-one", "tab-one", true, "kishore");

        fireEvent.keyDown(input, { key: "Escape" });
        expect(browserApi.respondDialog).toHaveBeenLastCalledWith("agent-one", "tab-one", false, undefined);
    });

    it("offers leave or stay for a page holding onto its changes", async () => {
        vi.mocked(browserApi.snapshot).mockResolvedValue({
            tabs: [{ ...snapshot.tabs[0], dialog: { kind: "beforeunload", message: "", defaultPrompt: "", url: "https://example.com/" } }],
            activeTabId: "tab-one",
        });
        await renderStreamingPane();
        expect(screen.getByRole("dialog", { name: "Leave this page?" })).toHaveTextContent("Changes you made may not be saved.");
        fireEvent.click(screen.getByRole("button", { name: "Stay" }));
        expect(browserApi.respondDialog).toHaveBeenCalledWith("agent-one", "tab-one", false, undefined);
        fireEvent.click(screen.getByRole("button", { name: "Leave" }));
        expect(browserApi.respondDialog).toHaveBeenLastCalledWith("agent-one", "tab-one", true, undefined);
    });

    /* A click into a busy page comes back late or not at all; the frozen frame
       already says so, and a toast for every one of them buried the app. */
    it("keeps a failed click out of the toasts", async () => {
        vi.mocked(browserApi.pointer).mockRejectedValue(new Error("browser CDP Input.dispatchMouseEvent timed out"));
        const viewport = await renderStreamingPane();
        fireEvent.pointerDown(viewport, { pointerId: 3, clientX: 12, clientY: 18 });
        fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 12, clientY: 18 });
        await act(async () => {});
        expect(browserApi.pointer).toHaveBeenCalledTimes(2);
        expect(useToasts.getState().toasts).toEqual([]);
    });

    it("tells the page the button is still down while the pointer drags", async () => {
        const viewport = await renderStreamingPane();
        /* Moves closer together than a frame are dropped, so each one here
           lands well after the last. */
        let now = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => (now += 100));
        fireEvent.pointerDown(viewport, { pointerId: 3, clientX: 12, clientY: 18 });
        fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 40, clientY: 18 });
        expect(browserApi.pointer).toHaveBeenLastCalledWith("agent-one", expect.objectContaining({ kind: "move", button: "left" }));
        fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 40, clientY: 18 });
        fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 80, clientY: 18 });
        expect(browserApi.pointer).toHaveBeenLastCalledWith("agent-one", expect.objectContaining({ kind: "move", button: "none" }));
    });
});
