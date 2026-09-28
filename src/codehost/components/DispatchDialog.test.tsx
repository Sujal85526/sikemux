import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ branches: vi.fn(() => Promise.resolve(["main", "dev"])), dispatch: vi.fn(() => new Promise(() => {})) }));

import { DispatchDialog } from "./DispatchDialog";
import { InHost, registerTestHost, TEST_HOST } from "../testHost";

const host = registerTestHost(api);
const wrapper = ({ children }: { children: React.ReactNode }) => <InHost host={host}>{children}</InHost>;

const workflow = { id: "1", name: "Deploy", path: ".github/workflows/deploy.yml", state: "active", active: true, url: "" };

afterEach(cleanup);

describe("DispatchDialog", () => {
    it("is a modal dialog that closes on Escape", async () => {
        const onClose = vi.fn();
        render(<DispatchDialog repo={{ provider: TEST_HOST, owner: "a", name: "b" }} workflow={workflow} defaultBranch="main" onClose={onClose} />, {
            wrapper,
        });
        await act(async () => {});
        const dialog = screen.getByRole("dialog", { name: "Run Deploy" });
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        fireEvent.keyDown(screen.getByLabelText("Branch or tag"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("starts the workflow once however many times it is asked", async () => {
        render(<DispatchDialog repo={{ provider: TEST_HOST, owner: "a", name: "b" }} workflow={workflow} defaultBranch="main" onClose={() => {}} />, {
            wrapper,
        });
        const run = screen.getByRole("button", { name: "Run workflow" });
        await act(async () => {
            fireEvent.click(run);
            fireEvent.click(run);
        });
        expect(api.dispatch).toHaveBeenCalledTimes(1);
    });
});
