import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile } from "../api";

const api = vi.hoisted(() => ({ schemas: vi.fn(), tables: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { invalidate } from "../../../plugin-api/resources";
import { SchemaTree } from "./SchemaTree";

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

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("database."));
});
beforeEach(() => {
    api.schemas.mockReset();
    api.tables.mockReset();
    api.schemas.mockResolvedValue(["public", "audit"]);
    api.tables.mockResolvedValue([
        { name: "customers", kind: "table" },
        { name: "orders", kind: "table" },
        { name: "big_orders", kind: "view" },
    ]);
});

const renderTree = (props: Partial<Parameters<typeof SchemaTree>[0]> = {}) => {
    const all = { profile: shop, active: true, schema: null, table: null, onSchema: vi.fn(), onOpen: vi.fn(), ...props };
    render(<SchemaTree {...all} />);
    return all;
};

describe("SchemaTree", () => {
    it("lists the tables of the usual schema and opens one", async () => {
        const props = renderTree();
        fireEvent.click(await screen.findByText("orders"));
        expect(api.tables).toHaveBeenCalledWith("p1", "public");
        expect(props.onOpen).toHaveBeenCalledWith({ schema: "public", name: "orders" });
        expect(screen.getByTitle("public.big_orders, a view")).toBeInTheDocument();
    });

    it("filters by name and says when nothing matches", async () => {
        renderTree();
        await screen.findByText("orders");
        fireEvent.change(screen.getByLabelText("Filter tables"), { target: { value: "ORD" } });
        expect(screen.queryByText("customers")).toBeNull();
        expect(screen.getByText("big_orders")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Filter tables"), { target: { value: "zzz" } });
        expect(screen.getByText("No table matches.")).toBeInTheDocument();
    });

    it("marks the open table", async () => {
        renderTree({ table: { schema: "public", name: "customers" } });
        expect((await screen.findByText("customers")).closest("button")).toHaveClass("active");
    });

    it("asks for a schema when a MySQL connection names no database", async () => {
        renderTree({ profile: { ...shop, engine: "mysql", database: "" } });
        expect(await screen.findByText("This connection names no database. Pick a schema above.")).toBeInTheDocument();
        expect(api.tables).not.toHaveBeenCalled();
    });

    it("says why the tables could not be listed", async () => {
        api.tables.mockRejectedValue({ category: "query", message: "permission denied for schema audit" });
        renderTree({ schema: "audit" });
        expect(await screen.findByRole("alert")).toHaveTextContent("permission denied for schema audit");
    });
});
