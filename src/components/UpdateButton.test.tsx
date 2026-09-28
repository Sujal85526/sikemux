import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { getState, setState } from "../state/store";
import { UpdateButton } from "./RailMasthead";

const initial = getState();
const RING_LENGTH = 2 * Math.PI * 9;

function showButton(overrides: Partial<NonNullable<ReturnType<typeof getState>["pendingUpdate"]>>) {
    setState({
        pendingUpdate: {
            version: "0.4.0-nightly.1",
            currentVersion: "0.3.5",
            notes: null,
            date: null,
            credits: null,
            state: "downloading",
            error: null,
            downloadedBytes: 0,
            totalBytes: null,
            ...overrides,
        },
    });
    return render(<UpdateButton />);
}

function ring(): Element | null {
    return document.querySelector(".update-ring");
}

function ringShown(): number {
    return Number(document.querySelector(".update-ring-bar")!.getAttribute("stroke-dasharray")!.split(" ")[0]);
}

afterEach(() => {
    cleanup();
    setState(initial);
});

describe("UpdateButton progress", () => {
    it("fills the ring to the downloaded fraction when the size is known", () => {
        showButton({ downloadedBytes: 25, totalBytes: 100 });

        expect(ring()).not.toHaveClass("update-ring-spin");
        expect(ringShown()).toBeCloseTo(RING_LENGTH * 0.25);
        expect(screen.getByRole("button")).toBeDisabled();
    });

    it("spins the ring when the size is unknown", () => {
        showButton({ downloadedBytes: 4096, totalBytes: null });

        expect(ring()).toHaveClass("update-ring-spin");
    });

    it("shows no ring before the download starts", () => {
        showButton({ state: "available", downloadedBytes: 0, totalBytes: null });

        expect(ring()).toBeNull();
        expect(screen.getByRole("button")).toBeEnabled();
    });

    it("renders nothing without a pending update", () => {
        render(<UpdateButton />);

        expect(screen.queryByRole("button")).toBeNull();
    });
});
