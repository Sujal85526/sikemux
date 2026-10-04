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

    it("lists each connection with its engine and where it is", async () => {
        renderPane();
        expect(await screen.findByText("PostgreSQL · app@db.internal:5432/shop")).toBeInTheDocument();
        expect(screen.getByText("SQLite · app.db")).toBeInTheDocument();
        expect(screen.getByText("Pick a connection to see it, or add a new one.")).toBeInTheDocument();
    });

    it("shows a picked connection and connects to it", async () => {
        api.connect.mockResolvedValue({ id: "p1", version: "PostgreSQL 16.4" });
        renderPane();
        fireEvent.click(await screen.findByText("Shop"));
        expect(screen.getByRole("article", { name: "Shop" })).toHaveTextContent("Read only");
        expect(screen.getByText("Saved in the Keychain")).toBeInTheDocument();

        api.connected.mockResolvedValue([{ id: "p1", version: "PostgreSQL 16.4" }]);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect" })));
        expect(api.connect).toHaveBeenCalledWith("p1");
        expect(await screen.findByRole("region", { name: "Query Shop" })).toBeInTheDocument();
        expect(screen.getByText("PostgreSQL 16.4")).toBeInTheDocument();
        expect(screen.getByLabelText("Connected")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    });

    it("lists a connected database's tables and opens one", async () => {
        api.connected.mockResolvedValue([{ id: "p1", version: "PostgreSQL 16.4" }]);
        renderPane();
        fireEvent.click(await screen.findByText("Shop"));
        fireEvent.click(await screen.findByText("orders"));
        expect(await screen.findByRole("tab", { name: "orders" })).toHaveAttribute("aria-selected", "true");
        expect(await screen.findByRole("article", { name: "public.orders" })).toBeInTheDocument();
    });

    it("says why a connection failed", async () => {
        api.connect.mockRejectedValue({ category: "connect", message: "db.internal:5432 did not answer within 10s" });
        renderPane();
        fireEvent.click(await screen.findByText("Shop"));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect" })));
        expect(screen.getByRole("alert")).toHaveTextContent("did not answer within 10s");
    });

    it("opens the form on the picked connection to edit it", async () => {
        renderPane();
        fireEvent.click(await screen.findByText("Local"));
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        expect(screen.getByRole("form", { name: "Edit Local" })).toBeInTheDocument();
        expect(screen.getByLabelText("Database file")).toHaveValue("/Users/me/app.db");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("article", { name: "Local" })).toBeInTheDocument();
    });
});
