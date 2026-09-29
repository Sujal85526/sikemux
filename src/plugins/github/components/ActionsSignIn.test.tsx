import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionsStatus } from "../api";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), actionsApi: { signIn } }));

import { ActionsSignIn } from "./ActionsSignIn";

const status: ActionsStatus = {
    configured: false,
    account: null,
    host: "github.com",
    login: "",
    tokenSource: null,
    tokenVariable: null,
    scopes: [],
    canWriteWorkflows: false,
    ok: false,
    authFailed: false,
    message: null,
};

afterEach(cleanup);

describe("ActionsSignIn", () => {
    it("signs in once however many times Enter is pressed while it checks", async () => {
        signIn.mockReset().mockReturnValue(new Promise(() => {}));
        render(<ActionsSignIn status={status} onSignedIn={() => {}} />);
        const token = screen.getByPlaceholderText("ghp_… or github_pat_…");
        fireEvent.change(token, { target: { value: "ghp_secret" } });
        await act(async () => {
            fireEvent.keyDown(token, { key: "Enter" });
            fireEvent.keyDown(token, { key: "Enter" });
        });
        expect(signIn).toHaveBeenCalledTimes(1);
        expect(signIn).toHaveBeenCalledWith("github.com", "ghp_secret");
    });

    it("names the variable an environment token came from", () => {
        render(
            <ActionsSignIn
                status={{ ...status, host: "ghe.corp", tokenSource: "environment", tokenVariable: "GH_ENTERPRISE_TOKEN" }}
                onSignedIn={() => {}}
            />,
        );
        expect(screen.getByText(/GH_ENTERPRISE_TOKEN is set in your shell/)).toBeTruthy();
    });

    it("does not sign in with an empty token", () => {
        signIn.mockReset();
        render(<ActionsSignIn status={status} onSignedIn={() => {}} />);
        fireEvent.keyDown(screen.getByPlaceholderText("ghp_… or github_pat_…"), { key: "Enter" });
        expect(signIn).not.toHaveBeenCalled();
    });
});
