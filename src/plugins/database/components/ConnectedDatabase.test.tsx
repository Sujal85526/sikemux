import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, TableInfo } from "../api";

const api = vi.hoisted(() => ({ query: vi.fn(), describe: vi.fn(), history: vi.fn(), disconnect: vi.fn(), connected: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { invalidate } from "../../../plugin-api/resources";
import { forgetQuery, readQuery } from "../queryState";
import type { DatabaseView } from "../state";
import { ConnectedDatabase } from "./ConnectedDatabase";

const shop: DatabaseProfile = { id: "p1", name: "Shop", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/a.db" };
const orders: TableInfo = { schema: "main", name: "orders", kind: "table", columns: [], indexes: [], foreignKeys: [] };
const view: DatabaseView = { selected: "p1", editing: null, showing: "query", schema: null, table: null };

afterEach(() => {
    cleanup();
    forgetQuery("p1");
    invalidate((kind) => kind.startsWith("database."));
});
beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.describe.mockResolvedValue(orders);
    api.history.mockResolvedValue([]);
    api.query.mockResolvedValue({ results: [], millis: 1 });
});

function renderOpen(change: Partial<DatabaseView> = {}) {
    const onView = vi.fn();
    const onEdit = vi.fn();
    render(
        <ConnectedDatabase
            profile={shop}
            connected={{ id: "p1", version: "SQLite 3.46.0" }}
            active
            view={{ ...view, ...change }}
            onView={onView}
            onEdit={onEdit}
        />,
    );
    return { onView, onEdit };
}

describe("ConnectedDatabase", () => {
    it("names the database and its server, and opens on the query", () => {
        renderOpen();
        expect(screen.getByText("SQLite 3.46.0")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Query" })).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByRole("tab", { name: "Table" })).toBeNull();
        expect(screen.getByRole("region", { name: "Query Shop" })).toBeInTheDocument();
    });

    it("shows the open table as a tab, and previewing it runs the query", async () => {
        const { onView } = renderOpen({ showing: "table", table: { schema: "main", name: "orders" } });
        expect(screen.getByRole("tab", { name: "orders" })).toHaveAttribute("aria-selected", "true");
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Preview rows" })));
        expect(onView).toHaveBeenCalledWith({ showing: "query" });
        expect(readQuery("p1").sql).toBe('select * from "orders" limit 100;');
        expect(api.query).toHaveBeenCalledWith("p1", 'select * from "orders" limit 100;', 500);
    });

    it("switches to the history and disconnects", async () => {
        api.disconnect.mockResolvedValue(undefined);
        const { onView } = renderOpen();
        fireEvent.click(screen.getByRole("tab", { name: "History" }));
        expect(onView).toHaveBeenCalledWith({ showing: "history" });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Disconnect" })));
        expect(api.disconnect).toHaveBeenCalledWith("p1");
    });
});
