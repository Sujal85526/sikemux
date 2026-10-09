import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, HistoryEntry } from "../api";

const api = vi.hoisted(() => ({ history: vi.fn(), clearHistory: vi.fn() }));
const host = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));
vi.mock("../../../plugin-api/host", async (importOriginal) => ({ ...(await importOriginal<object>()), ...host }));

import { invalidate } from "../../../plugin-api/resources";
import { HistoryPanel } from "./HistoryPanel";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

const shop: DatabaseProfile = { id: "p1", name: "Shop", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/a.db" };

const entries: HistoryEntry[] = [
    { sql: "select * from nowhere", at: NOW - 30_000, millis: 2, ok: false, rows: null, error: "no such table: nowhere", source: "agent" },
    { sql: "select * from orders", at: NOW - 600_000, millis: 14, ok: true, rows: 2, error: null, source: "person" },
];

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("database."));
});
beforeEach(() => {
    api.history.mockReset();
    api.clearHistory.mockReset();
    host.confirmDialog.mockReset();
    api.history.mockResolvedValue(entries);
});

describe("HistoryPanel", () => {
    it("lists past queries newest first, with what came of each and who ran it", async () => {
        render(<HistoryPanel profile={shop} active onOpen={vi.fn()} now={NOW} />);
        const items = await screen.findAllByRole("listitem");
        expect(items[0]).toHaveTextContent("select * from nowhere");
        expect(items[0]).toHaveTextContent("just now");
        expect(items[0]).toHaveTextContent("no such table: nowhere");
        expect(within(items[0]).getByText("agent")).toBeInTheDocument();
        expect(items[1]).toHaveTextContent("10 min ago14 ms2 rows");
    });

    it("opens a past query in the editor or runs it again", async () => {
        const onOpen = vi.fn();
        render(<HistoryPanel profile={shop} active onOpen={onOpen} now={NOW} />);
        const items = await screen.findAllByRole("listitem");
        fireEvent.click(within(items[1]).getByRole("button", { name: "Open" }));
        expect(onOpen).toHaveBeenLastCalledWith("select * from orders", false);
        fireEvent.click(within(items[1]).getByRole("button", { name: "Run again" }));
        expect(onOpen).toHaveBeenLastCalledWith("select * from orders", true);
    });

    it("searches the history", async () => {
        render(<HistoryPanel profile={shop} active onOpen={vi.fn()} now={NOW} />);
        await screen.findAllByRole("listitem");
        api.history.mockResolvedValue([]);
        fireEvent.change(screen.getByLabelText("Search past queries"), { target: { value: "customers" } });
        await waitFor(() => expect(api.history).toHaveBeenLastCalledWith("p1", "customers"));
        expect(await screen.findByText("No past query matches.")).toBeInTheDocument();
    });

    it("clears the history only once it is confirmed", async () => {
        render(<HistoryPanel profile={shop} active onOpen={vi.fn()} now={NOW} />);
        await screen.findAllByRole("listitem");
        host.confirmDialog.mockResolvedValue(false);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear history" })));
        expect(api.clearHistory).not.toHaveBeenCalled();
        host.confirmDialog.mockResolvedValue(true);
        api.clearHistory.mockResolvedValue(undefined);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear history" })));
        expect(api.clearHistory).toHaveBeenCalledWith("p1");
    });
});
