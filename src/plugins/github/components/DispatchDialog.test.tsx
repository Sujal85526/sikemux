import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ branches: vi.fn(() => Promise.resolve(["main", "dev"])), dispatch: vi.fn(() => new Promise(() => {})) }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), actionsApi: api }));

import { DispatchDialog } from "./DispatchDialog";

const workflow = { id: 1, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active", active: true, url: "" };

afterEach(cleanup);

describe("DispatchDialog", () => {
    it("is a modal dialog that closes on Escape", async () => {
        const onClose = vi.fn();
        render(<DispatchDialog repo={{ owner: "a", name: "b" }} workflow={workflow} defaultBranch="main" onClose={onClose} />);
        await act(async () => {});
        const dialog = screen.getByRole("dialog", { name: "Run Deploy" });
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        fireEvent.keyDown(screen.getByLabelText("Branch or tag"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("starts the workflow once however many times it is asked", async () => {
        render(<DispatchDialog repo={{ owner: "a", name: "b" }} workflow={workflow} defaultBranch="main" onClose={() => {}} />);
        const run = screen.getByRole("button", { name: "Run workflow" });
        await act(async () => {
            fireEvent.click(run);
            fireEvent.click(run);
        });
        expect(api.dispatch).toHaveBeenCalledTimes(1);
    });
});
