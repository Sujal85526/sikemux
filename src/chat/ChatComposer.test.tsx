import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../state/types";
import { ChatComposer } from "./ChatComposer";
import { PathRootsProvider } from "./FileRef";

const mocks = vi.hoisted(() => ({
    list: vi.fn(async () => ["src/main.ts", "src/lib/util.ts", "README.md"]),
    onSend: vi.fn((): boolean => true),
}));

vi.mock("../api/files", () => ({ filesApi: { list: mocks.list } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const agent: Agent = {
    id: "composer-agent",
    type: "codex",
    title: "Agent",
    startup: "codex",
    permissionMode: "workspace-write",
    launchState: "live",
};

function renderComposer() {
    render(
        <PathRootsProvider cwd="/repo">
            <ChatComposer
                agent={agent}
                paneRef={createRef()}
                visible
                connection="ready"
                running={false}
                steerable={false}
                commands={[]}
                setup={{}}
                awaitingPermission={false}
                agentLocked={false}
                changingConfig={false}
                changingPermissions={false}
                permissionApplied
                placeholder=""
                error={null}
                onError={() => {}}
                onSend={mocks.onSend}
                onSteerQueued={() => {}}
                onStop={() => {}}
                queuedCount={0}
                usage={null}
                onConfig={() => {}}
                history={[]}
            />
        </PathRootsProvider>,
    );
    return screen.getByRole("textbox", { name: "Message agent" });
}

function type(editor: HTMLElement, value: string) {
    fireEvent.change(editor, { target: { value, selectionStart: value.length } });
}

afterEach(() => {
    cleanup();
    mocks.onSend.mockClear();
});

describe("ChatComposer @ picker", () => {
    it("lists project files and folders matching what follows the @", async () => {
        const editor = renderComposer();
        type(editor, "look at @util");
        expect(await screen.findByRole("option", { name: /util\.ts/ })).toBeInTheDocument();
        expect(screen.queryByRole("option", { name: /README/ })).not.toBeInTheDocument();
        type(editor, "look at @lib");
        expect(await screen.findByRole("option", { name: /^lib/ })).toBeInTheDocument();
    });

    it("takes the token out of the text and attaches the chosen path", async () => {
        const editor = renderComposer();
        type(editor, "look at @main please");
        fireEvent.change(editor, { target: { value: "look at @main please", selectionStart: 13 } });
        await screen.findByRole("option", { name: /main\.ts/ });
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor).toHaveValue("look at please");
        expect(screen.getByTitle("/repo/src/main.ts")).toBeInTheDocument();

        fireEvent.keyDown(editor, { key: "Enter" });
        expect(mocks.onSend).toHaveBeenCalledWith("look at please", ["/repo/src/main.ts"], false);
    });

    it("leaves the @ in place when Escape dismisses the picker", async () => {
        const editor = renderComposer();
        type(editor, "@READ");
        await screen.findByRole("option", { name: /README/ });
        fireEvent.keyDown(editor, { key: "Escape" });
        await act(async () => {});
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(editor).toHaveValue("@READ");
    });

    it("keeps an email address as text", async () => {
        const editor = renderComposer();
        type(editor, "mail me@main");
        await act(async () => {});
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
});
