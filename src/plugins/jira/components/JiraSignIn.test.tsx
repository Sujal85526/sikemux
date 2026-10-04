import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraStatus } from "../api";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), jiraApi: { signIn } }));

import { JiraSignIn } from "./JiraSignIn";

const signedIn: JiraStatus = {
    configured: true,
    sites: [{ host: "acme.atlassian.net", email: "me@acme.dev", displayName: "Me", default: true }],
    ok: true,
    authFailed: false,
    message: null,
};

afterEach(cleanup);
beforeEach(() => {
    signIn.mockReset();
});

function fill(site: string, email: string, token: string) {
    fireEvent.change(screen.getByPlaceholderText("your-team.atlassian.net"), { target: { value: site } });
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: email } });
    fireEvent.change(screen.getByPlaceholderText("ATATT…"), { target: { value: token } });
}

describe("JiraSignIn", () => {
    it("signs in with the site, email and token once all three are given", async () => {
        signIn.mockResolvedValue(signedIn);
        const onSignedIn = vi.fn();
        render(<JiraSignIn status={undefined} onSignedIn={onSignedIn} />);
        const button = screen.getByRole("button", { name: "Sign in" });
        expect(button).toBeDisabled();

        fill(" acme.atlassian.net ", "me@acme.dev", "ATATT-secret");
        await act(async () => fireEvent.click(button));

        expect(signIn).toHaveBeenCalledWith("acme.atlassian.net", "me@acme.dev", "ATATT-secret");
        expect(onSignedIn).toHaveBeenCalledWith(signedIn);
    });

    it("shows why Jira turned the token down and keeps the form", async () => {
        signIn.mockRejectedValue({ category: "auth", message: "jira: sign-in failed: the email or API token was not accepted" });
        const onSignedIn = vi.fn();
        render(<JiraSignIn status={undefined} onSignedIn={onSignedIn} />);
        fill("acme.atlassian.net", "me@acme.dev", "wrong");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));

        expect(onSignedIn).not.toHaveBeenCalled();
        expect(await screen.findByText(/not accepted/)).toBeInTheDocument();
    });

    it("says a saved token stopped working", () => {
        render(
            <JiraSignIn
                status={{ ...signedIn, ok: false, authFailed: true, message: "jira: sign-in failed: token revoked" }}
                onSignedIn={() => {}}
            />,
        );
        expect(screen.getByText(/token revoked/)).toBeInTheDocument();
    });
});
