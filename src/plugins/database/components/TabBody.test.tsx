import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, TableInfo } from "../api";

const api = vi.hoisted(() => ({ describe: vi.fn(), history: vi.fn(), connect: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { invalidate } from "../../../plugin-api/resources";
import { consoleTab, historyTab, tableTab, type DatabaseTab } from "../tabs";
import { TabBody } from "./TabBody";

const shop: DatabaseProfile = { id: "p1", name: "Shop", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/a.db" };
const orders: TableInfo = {
    schema: "main",
    name: "orders",
    kind: "table",
    columns: [],
    indexes: [],
    foreignKeys: [{ name: null, columns: ["customer_id"], referencesSchema: null, referencesTable: "customers", referencesColumns: ["id"] }],
};
const connected = { id: "p1", version: "SQLite 3.46.0" };

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("database."));
});
beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.describe.mockResolvedValue(orders);
    api.history.mockResolvedValue([]);
});

function renderTab(tab: DatabaseTab, open = true) {
    const props = { onQuery: vi.fn(), onOpenTable: vi.fn(), onEdit: vi.fn() };
    render(<TabBody tab={tab} profile={shop} connected={open ? connected : null} active {...props} />);
    return props;
}

describe("TabBody", () => {
    it("shows a console with the server it talks to", () => {
        renderTab(consoleTab("p1", 1));
        expect(screen.getByText("SQLite 3.46.0")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Query Shop" })).toBeInTheDocument();
    });

    it("previews a table into a console and follows its foreign keys", async () => {
        const props = renderTab(tableTab("p1", "main", "orders"));
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Preview rows" })));
        expect(props.onQuery).toHaveBeenCalledWith('select * from "orders" limit 100;', true);
        fireEvent.click(screen.getByRole("button", { name: "customers(id)" }));
        expect(props.onOpenTable).toHaveBeenCalledWith("main", "customers");
    });

    it("offers to connect before showing a console or table on a closed connection", () => {
        renderTab(tableTab("p1", "main", "orders"), false);
        expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
        expect(api.describe).not.toHaveBeenCalled();
    });

    it("shows the history whether or not the connection is open", async () => {
        renderTab(historyTab("p1"), false);
        expect(await screen.findByRole("region", { name: "History of Shop" })).toBeInTheDocument();
    });
});
