import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile } from "../api";

const api = vi.hoisted(() => ({
    schemas: vi.fn(),
    tables: vi.fn(),
    describe: vi.fn(),
    query: vi.fn(),
    history: vi.fn(),
    profiles: vi.fn(),
    connected: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    save: vi.fn(),
    test: vi.fn(),
    remove: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { invalidate } from "../../../plugin-api/resources";
import { DatabasePane } from "./DatabasePane";

const shop: DatabaseProfile = {
    id: "p1",
    name: "Shop",
    readOnly: true,
    agentWrites: false,
    hasPassword: true,
    engine: "postgres",
    host: "db.internal",
    port: null,
    database: "shop",
    user: "app",
    tls: "prefer",
};

const local: DatabaseProfile = {
    id: "p2",
    name: "Local",
    readOnly: false,
    agentWrites: false,
    hasPassword: false,
    engine: "sqlite",
    path: "/Users/me/app.db",
};

let pane = 0;
const renderPane = () => render(<DatabasePane paneId={`pane-${++pane}`} active />);

afterEach(() => {
    cleanup();
    invalidate((kind) => kind.startsWith("database."));
});

beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.profiles.mockResolvedValue([shop, local]);
    api.connected.mockResolvedValue([]);
    api.schemas.mockResolvedValue(["public"]);
    api.tables.mockResolvedValue([{ name: "orders", kind: "table" }]);
    api.describe.mockResolvedValue({ schema: "public", name: "orders", kind: "table", columns: [], indexes: [], foreignKeys: [] });
});

describe("DatabasePane", () => {
    it("invites the first connection when none is saved", async () => {
        api.profiles.mockResolvedValue([]);
        renderPane();
        expect(await screen.findByRole("heading", { name: "Connect a database" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Add a connection" }));
        expect(screen.getByRole("form", { name: "New connection" })).toBeInTheDocument();
    });

    it("lists every connection in the explorer, with where each one points", async () => {
        renderPane();
        expect(await screen.findByRole("treeitem", { name: "Shop" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Shop/ })).toHaveAttribute("title", "PostgreSQL · app@db.internal:5432/shop");
        expect(screen.getByRole("button", { name: /Local/ })).toHaveAttribute("title", "SQLite · app.db");
        expect(screen.getByText(/Open a connection in the explorer/)).toBeInTheDocument();
    });

    it("connects from the explorer, opens a console, and opens tables as tabs of their own", async () => {
        api.connect.mockResolvedValue({ id: "p1", version: "PostgreSQL 16.4" });
        api.tables.mockResolvedValue([
            { name: "customers", kind: "table" },
            { name: "orders", kind: "table" },
        ]);
        renderPane();
        api.connected.mockResolvedValue([{ id: "p1", version: "PostgreSQL 16.4" }]);
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: /Shop/ })));
        expect(api.connect).toHaveBeenCalledWith("p1");
        expect(await screen.findByRole("tab", { name: "Shop console" })).toHaveAttribute("aria-selected", "true");
        expect(await screen.findByRole("region", { name: "Query Shop" })).toBeInTheDocument();
        expect(await screen.findByLabelText("Connected")).toBeInTheDocument();

        fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
        expect(await screen.findByRole("article", { name: "public.orders" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /^customers/ }));
        expect(screen.getByRole("tab", { name: "Shop customers" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Shop console", "Shop orders", "Shop customers"]);
    });

    it("keeps tabs from different connections side by side", async () => {
        api.connected.mockResolvedValue([
            { id: "p1", version: "PostgreSQL 16.4" },
            { id: "p2", version: "SQLite 3.46.0" },
        ]);
        api.history.mockResolvedValue([]);
        renderPane();
        fireEvent.contextMenu(await screen.findByRole("button", { name: /Shop/ }));
        fireEvent.click(screen.getByText("New console"));
        fireEvent.contextMenu(screen.getByRole("button", { name: /Local/ }));
        fireEvent.click(screen.getByText("History"));
        expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Shop console", "Local history"]);
        expect(await screen.findByRole("region", { name: "History of Local" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("tab", { name: "Shop console" }));
        expect(screen.getByRole("region", { name: "Query Shop" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Close Shop console" }));
        expect(screen.getByRole("tab", { name: "Local history" })).toHaveAttribute("aria-selected", "true");
    });

    it("previews a table into its connection's console", async () => {
        api.connected.mockResolvedValue([{ id: "p1", version: "PostgreSQL 16.4" }]);
        api.query.mockResolvedValue({ results: [], millis: 2 });
        renderPane();
        fireEvent.click(await screen.findByRole("button", { name: /Shop/ }));
        fireEvent.contextMenu(await screen.findByRole("button", { name: /public/ }));
        fireEvent.click(screen.getByText("Refresh"));
        fireEvent.click(screen.getByRole("button", { name: /public/ }));
        fireEvent.click(await screen.findByRole("button", { name: /^tables/ }));
        await act(async () => fireEvent.doubleClick(await screen.findByRole("button", { name: /^orders/ })));
        expect(api.query).toHaveBeenCalledWith("p1", 'select * from "public"."orders" limit 100;', 500);
        expect(screen.getByRole("tab", { name: "Shop console" })).toHaveAttribute("aria-selected", "true");
    });

    it("says why a connection failed", async () => {
        api.connect.mockRejectedValue({ category: "connect", message: "db.internal:5432 did not answer within 10s" });
        renderPane();
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: /Shop/ })));
        expect(screen.getByRole("alert")).toHaveTextContent("did not answer within 10s");
    });

    it("edits a connection from its menu, and shows its properties in a tab", async () => {
        renderPane();
        fireEvent.contextMenu(await screen.findByRole("button", { name: /Local/ }));
        fireEvent.click(screen.getByText("Edit connection…"));
        expect(screen.getByRole("form", { name: "Edit Local" })).toBeInTheDocument();
        expect(screen.getByLabelText("Database file")).toHaveValue("/Users/me/app.db");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        fireEvent.contextMenu(screen.getByRole("button", { name: /Shop/ }));
        fireEvent.click(screen.getByText("Properties"));
        expect(screen.getByRole("article", { name: "Shop" })).toHaveTextContent("Saved in the Keychain");
    });
});
