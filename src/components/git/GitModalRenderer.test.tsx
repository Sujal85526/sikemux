import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitModalRenderer } from "./GitModalRenderer";
import { getState, setState } from "../../state/store";

afterEach(() => {
    cleanup();
    setState({ gitModal: null });
});

describe("GitModalRenderer confirmations", () => {
    it("makes an explicitly confirmed destructive flow actionable with Enter", async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        setState({
            gitModal: {
                ownerPaneId: "git-pane",
                kind: "confirm",
                title: "Discard changes",
                body: "This cannot be undone.",
                destructive: true,
                confirmLabel: "discard",
                initialFocus: "confirm",
                confirmKey: "d",
                onConfirm,
            },
        });

        render(<GitModalRenderer paneId="git-pane" active />);
        const discard = screen.getByRole("button", { name: "discard" });
        await waitFor(() => expect(discard).toHaveFocus());

        await user.keyboard("{Enter}");

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(getState().gitModal).toBeNull();
    });

    it("keeps destructive confirmations cancel-focused by default but accepts their explicit key", async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        setState({
            gitModal: {
                ownerPaneId: "git-pane",
                kind: "confirm",
                title: "Discard changes",
                body: "This cannot be undone.",
                destructive: true,
                confirmLabel: "discard",
                confirmKey: "d",
                onConfirm,
            },
        });

        render(<GitModalRenderer paneId="git-pane" active />);
        await waitFor(() => expect(screen.getByRole("button", { name: "cancel" })).toHaveFocus());

        fireEvent.keyDown(window, { key: "d", repeat: true });
        expect(onConfirm).not.toHaveBeenCalled();
        expect(getState().gitModal).not.toBeNull();

        await user.keyboard("d");
        await user.keyboard("d");

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(getState().gitModal).toBeNull();
    });
});
