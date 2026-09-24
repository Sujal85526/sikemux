import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.4.0") }));

import { resetPersistenceForTests } from "../state/persist";
import { getState, setState } from "../state/store";
import type { ReleaseContributor, ReleaseNotes } from "../state/types";
import { resetReleaseCachesForTests, WhatsNewOverlay } from "./WhatsNewOverlay";

const initial = getState();

function person(login: string, commits: number): ReleaseContributor {
    return { login, name: login.toUpperCase(), commits, avatar: `https://avatars.githubusercontent.com/${login}` };
}

function release(overrides: Partial<ReleaseNotes> = {}): ReleaseNotes {
    return {
        version: "0.4.0",
        notes: "# Sikemux v0.4.0\n\nThe browser is a real one.\n\n## Agents\n\n- A structured view\n- Steering\n\n## The browser\n\n- Native tabs",
        date: "2026-09-22T12:45:39Z",
        commits: 442,
        compare: "https://github.com/nodelike/sikemux/compare/v0.3.5...v0.4.0",
        contributors: [person("nodelike", 438), person("octocat", 4)],
        ...overrides,
    };
}

function answer(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => handlers[command]?.(args));
}

beforeEach(() => {
    invoke.mockReset();
    resetReleaseCachesForTests();
    resetPersistenceForTests();
    setState(initial, true);
});

afterEach(() => {
    cleanup();
    resetPersistenceForTests();
});

describe("WhatsNewOverlay", () => {
    it("fetches the notes of the running build when nothing is waiting to install", async () => {
        const notes = vi.fn(() => release());
        answer({ release_notes: notes, release_avatars: () => ({}) });
        setState({ whatsNewOpen: true, pendingUpdate: null, lastReleaseNotes: null });

        render(<WhatsNewOverlay />);

        expect(await screen.findByRole("heading", { name: "Agents", level: 2 })).toBeInTheDocument();
        expect(notes).toHaveBeenCalledWith({ version: "0.4.0" });
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("v0.4.0");
        expect(screen.queryByRole("heading", { name: "Sikemux v0.4.0" })).not.toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
        expect(screen.getByText("442")).toBeInTheDocument();
        expect(screen.getByText("stable")).toBeInTheDocument();
    });

    it("uses the notes saved at install time for the build that is running", async () => {
        const notes = vi.fn();
        answer({ release_notes: notes, release_avatars: () => ({}) });
        setState({ whatsNewOpen: true, pendingUpdate: null, lastReleaseNotes: release({ notes: "Saved offline.\n" }) });

        render(<WhatsNewOverlay />);

        expect(await screen.findByText("Saved offline.")).toBeInTheDocument();
        expect(notes).not.toHaveBeenCalled();
    });

    it("says so when the notes cannot be loaded", async () => {
        answer({
            release_notes: () => {
                throw new Error("GitHub has no release notes for v0.4.0 (404 Not Found)");
            },
        });
        setState({ whatsNewOpen: true, pendingUpdate: null, lastReleaseNotes: null });

        render(<WhatsNewOverlay />);

        expect(await screen.findByText(/could not be loaded/)).toHaveTextContent("404 Not Found");
    });

    it("credits contributors and opens their GitHub profiles", async () => {
        const user = userEvent.setup();
        const opened = vi.fn();
        answer({
            release_avatars: () => ({ "https://avatars.githubusercontent.com/nodelike": "data:image/png;base64,AA==" }),
            open_url: opened,
        });
        setState({
            whatsNewOpen: true,
            lastReleaseNotes: null,
            pendingUpdate: {
                ...release(),
                version: "0.4.1",
                currentVersion: "0.4.0",
                state: "available",
                error: null,
                downloadedBytes: 0,
                totalBytes: null,
            },
        });

        const { container } = render(<WhatsNewOverlay />);

        await user.click(screen.getByRole("button", { name: /NODELIKE/ }));
        expect(opened).toHaveBeenCalledWith({ url: "https://github.com/nodelike", app: null, shortcut: null });
        await waitFor(() => expect(container.querySelector("img.wn-avatar")).toHaveAttribute("src", "data:image/png;base64,AA=="));
        expect(screen.getByRole("button", { name: /OCTOCAT/ })).toHaveTextContent("O");
        expect(screen.getByRole("button", { name: "Install v0.4.1" })).toBeInTheDocument();
    });

    it("keeps a long contributor list to a wall of faces with the rest behind a count", async () => {
        const user = userEvent.setup();
        const people = Array.from({ length: 40 }, (_, i) => person(`dev${i}`, 40 - i));
        answer({ release_avatars: () => ({}) });
        setState({ whatsNewOpen: true, pendingUpdate: null, lastReleaseNotes: release({ contributors: people }) });

        render(<WhatsNewOverlay />);

        expect(await screen.findByText("and 37 more")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: /^@dev/ })).toHaveLength(13);
        await user.click(screen.getByRole("button", { name: "+24" }));
        expect(screen.getAllByRole("button", { name: /^@dev/ })).toHaveLength(37);
    });
});
