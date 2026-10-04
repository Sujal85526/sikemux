import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile } from "../api";
import { blankDraft, draftOf } from "../profileForm";

const api = vi.hoisted(() => ({ test: vi.fn(), save: vi.fn(), remove: vi.fn() }));
const host = vi.hoisted(() => ({ pickFile: vi.fn(), confirmDialog: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));
vi.mock("../../../plugin-api/host", async (importOriginal) => ({ ...(await importOriginal<object>()), ...host }));

import { ProfileForm } from "./ProfileForm";

const saved: DatabaseProfile = {
    id: "p1",
    name: "Shop",
    readOnly: false,
    hasPassword: true,
    engine: "postgres",
    host: "db.internal",
    port: 6543,
    database: "shop",
    user: "app",
    tls: "verify-full",
};

afterEach(cleanup);
beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    Object.values(host).forEach((mock) => mock.mockReset());
});

function renderNew(overrides: Partial<Parameters<typeof ProfileForm>[0]> = {}) {
    const props = { initial: blankDraft(), saved: null, onSaved: vi.fn(), onRemoved: vi.fn(), onCancel: vi.fn(), ...overrides };
    render(<ProfileForm {...props} />);
    return props;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("ProfileForm", () => {
    it("says what is missing and keeps Test and Save off until it is filled in", () => {
        renderNew();
        expect(screen.getByText("Needs a name.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        type("Name", "Local");
        expect(screen.getByText("Needs a user name.")).toBeInTheDocument();
        type("User", "postgres");
        expect(screen.queryByText(/^Needs/)).toBeNull();
        expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    });

    it("tries the connection as typed and shows the server it reached", async () => {
        api.test.mockResolvedValue({ version: "PostgreSQL 16.4", millis: 12 });
        renderNew();
        type("Name", "Local");
        type("User", "postgres");
        type("Password", "s3cret!");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test" })));
        expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ name: "Local", user: "postgres", host: "localhost" }), "s3cret!");
        expect(screen.getByRole("status")).toHaveTextContent("Connected to PostgreSQL 16.4 in 12 ms");
    });

    it("shows the database's own words when the connection fails", async () => {
        api.test.mockRejectedValue({ category: "connect", message: 'password authentication failed for user "app"' });
        renderNew({ initial: draftOf(saved), saved });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test" })));
        expect(screen.getByRole("alert")).toHaveTextContent("password authentication failed");
    });

    it("keeps the saved password unless a new one is typed or it is forgotten", async () => {
        api.save.mockResolvedValue(saved);
        const props = renderNew({ initial: draftOf(saved), saved });
        expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Saved in the Keychain");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
        expect(api.save).toHaveBeenLastCalledWith(draftOf(saved), undefined);
        expect(props.onSaved).toHaveBeenCalledWith(saved);

        fireEvent.click(screen.getByRole("checkbox", { name: "Forget the saved password" }));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
        expect(api.save).toHaveBeenLastCalledWith(draftOf(saved), "");
    });

    it("switches to SQLite and fills the file and name from the file chooser", async () => {
        host.pickFile.mockResolvedValue("/Users/me/data/app.db");
        renderNew();
        fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
        expect(screen.queryByLabelText("Host")).toBeNull();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose…" })));
        expect(screen.getByLabelText("Database file")).toHaveValue("/Users/me/data/app.db");
        expect(screen.getByLabelText("Name")).toHaveValue("app.db");
    });

    it("removes a saved connection only after it is confirmed", async () => {
        const props = renderNew({ initial: draftOf(saved), saved });
        host.confirmDialog.mockResolvedValue(false);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
        expect(api.remove).not.toHaveBeenCalled();
        host.confirmDialog.mockResolvedValue(true);
        api.remove.mockResolvedValue(undefined);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
        expect(api.remove).toHaveBeenCalledWith("p1");
        expect(props.onRemoved).toHaveBeenCalled();
    });
});
