import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, TableInfo } from "../api";

const api = vi.hoisted(() => ({ describe: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { invalidate } from "../../../plugin-api/resources";
import { TableView } from "./TableView";

const shop: DatabaseProfile = {
    id: "p1",
    name: "Shop",
    readOnly: false,
    agentWrites: false,
    hasPassword: false,
    engine: "postgres",
    host: "localhost",
    port: null,
    database: "shop",
    user: "app",
    tls: "prefer",
};

const orders: TableInfo = {
    schema: "public",
    name: "orders",
    kind: "table",
    columns: [
        { name: "id", type: "bigint", nullable: false, default: "nextval('orders_id_seq'::regclass)", primaryKey: true },
        { name: "customer_id", type: "integer", nullable: false, default: null, primaryKey: false },
        { name: "note", type: "text", nullable: true, default: null, primaryKey: false },
    ],
    indexes: [
        { name: "orders_pkey", columns: ["id"], unique: true, primary: true },
        { name: "orders_by_customer", columns: ["customer_id"], unique: false, primary: false },
    ],
    foreignKeys: [
        {
            name: "orders_customer_id_fkey",
            columns: ["customer_id"],
            referencesSchema: "public",
            referencesTable: "customers",
            referencesColumns: ["id"],
        },
    ],
};

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("database."));
});
beforeEach(() => {
    api.describe.mockReset();
    api.describe.mockResolvedValue(orders);
});

const renderView = (profile: DatabaseProfile = shop) => {
    const onQuery = vi.fn();
    const onOpenTable = vi.fn();
    render(<TableView profile={profile} table={{ schema: "public", name: "orders" }} active onQuery={onQuery} onOpenTable={onOpenTable} />);
    return { onQuery, onOpenTable };
};

describe("TableView", () => {
    it("lists the columns with their types, keys and defaults", async () => {
        renderView();
        const columns = await screen.findByRole("region", { name: "Columns" });
        expect(api.describe).toHaveBeenCalledWith("p1", "orders", "public");
        const rows = within(columns).getAllByRole("row");
        expect(rows[1]).toHaveTextContent("idPKbigintno");
        expect(rows[3]).toHaveTextContent("notetextyes");
        const indexes = screen.getByRole("region", { name: "Indexes" });
        expect(indexes).toHaveTextContent("orders_by_customer(customer_id)");
        expect(indexes).toHaveTextContent("orders_pkey(id) primary");
    });

    it("lists the indexes and opens the table a foreign key points at", async () => {
        const { onOpenTable } = renderView();
        expect(await screen.findByText("orders_pkey")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "customers(id)" }));
        expect(onOpenTable).toHaveBeenCalledWith({ schema: "public", name: "customers" });
    });

    it("previews the rows or starts a query on the table", async () => {
        const { onQuery } = renderView();
        fireEvent.click(await screen.findByRole("button", { name: "Preview rows" }));
        expect(onQuery).toHaveBeenLastCalledWith('select * from "public"."orders" limit 100;', true);
        fireEvent.click(screen.getByRole("button", { name: "Query this table" }));
        expect(onQuery).toHaveBeenLastCalledWith('select * from "public"."orders" limit 100;', false);
    });

    it("leaves SQLite's main schema out of the query", async () => {
        api.describe.mockResolvedValue({ ...orders, schema: "main" });
        const { onQuery } = renderView({
            id: "p2",
            name: "Local",
            readOnly: false,
            agentWrites: false,
            hasPassword: false,
            engine: "sqlite",
            path: "/a.db",
        });
        fireEvent.click(await screen.findByRole("button", { name: "Preview rows" }));
        expect(onQuery).toHaveBeenLastCalledWith('select * from "orders" limit 100;', true);
    });
});
