import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_STATUS_EVENT, type RemoteStatus } from "../api/remote";
import { installIpcTransportForTests, MemoryIpcTransport, resetIpcTransportForTests } from "../api/transport";
import { useAccount } from "../account/account";
import { accountMeta, DevicesPage, notificationNote, removalNote, seenLabel } from "./DevicesPage";

const CORE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
    return {
        enabled: true,
        coreId: CORE,
        addresses: ["192.168.0.2:53786"],
        devices: [],
        connected: [],
        pairing: null,
        pending: [],
        owner: null,
        account: null,
        updateRequired: null,
        notifications: [],
        ...overrides,
    };
}

let transport: MemoryIpcTransport;

const SIGNED_OUT = { signedIn: false, userId: null, email: null, name: null, picture: null };
const SIGNED_IN = { signedIn: true, userId: "user_2abc", email: "me@example.com", name: null, picture: null };
let account: typeof SIGNED_OUT | typeof SIGNED_IN;

beforeEach(() => {
    transport = new MemoryIpcTransport();
    installIpcTransportForTests(transport);
    account = SIGNED_OUT;
    transport.register("account_status", () => account);
    transport.register("account_refresh_profile", () => account);
    useAccount.setState({ account: null });
});

afterEach(() => {
    cleanup();
    resetIpcTransportForTests();
    vi.useRealTimers();
});

describe("DevicesPage", () => {
    it("turns remote access on and shows the way to pair once it is", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () => status({ enabled: false }));
        const setEnabled = vi.fn(() => status());
        transport.register("remote_set_enabled", setEnabled);
        render(<DevicesPage />);

        expect(await screen.findByText("off")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Pair a device" })).toBeDisabled();
        await user.click(screen.getByRole("switch", { name: "Allow paired devices" }));

        expect(setEnabled).toHaveBeenCalledWith({ enabled: true }, expect.anything());
        await waitFor(() => expect(screen.getByRole("button", { name: "Pair a device" })).toBeEnabled());
        expect(screen.getByText(CORE.slice(0, 8))).toBeInTheDocument();
    });

    it("shows the code, then lets the person allow the device that typed it", async () => {
        const user = userEvent.setup();
        const expiresAt = Date.now() + 4 * 60_000;
        transport.register("remote_status", () => status());
        transport.register("remote_open_pairing", () =>
            status({ pairing: { code: "482913", expiresAt, link: "sikemux://pair?core=core&code=482913" } }),
        );
        const answer = vi.fn(() =>
            status({
                devices: [{ id: PHONE, name: "Kishore's phone", platform: "ios", access: "watch", pairedAt: 1, lastSeen: null }],
            }),
        );
        transport.register("remote_answer_pairing", answer);
        render(<DevicesPage />);

        await user.click(await screen.findByRole("button", { name: "Pair a device" }));
        expect(await screen.findByText("482 913")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeInTheDocument();
        expect(screen.getByText(/Expires in 4:00/)).toBeInTheDocument();

        transport.emit(
            REMOTE_STATUS_EVENT,
            status({ pending: [{ id: "request-1", deviceId: PHONE, name: "Kishore's phone", platform: "ios", fromAccount: false }] }),
        );
        expect(await screen.findByText("Kishore's phone wants to pair")).toBeInTheDocument();
        expect(screen.getByText(PHONE.slice(0, 8))).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /access for this device/ }));
        await user.click(await screen.findByRole("option", { name: /Watch and approve/ }));
        await user.click(screen.getByRole("button", { name: "Allow" }));

        expect(answer).toHaveBeenCalledWith({ id: "request-1", allow: true, access: "watch" }, expect.anything());
        expect(await screen.findByText("iOS · never connected")).toBeInTheDocument();
    });

    it("asks about a phone that came from the account, with no code open", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () =>
            status({ pending: [{ id: "join-1", deviceId: PHONE, name: "Pixel 8", platform: "android", fromAccount: true }] }),
        );
        const answer = vi.fn(() => status());
        transport.register("remote_answer_pairing", answer);
        render(<DevicesPage />);

        const request = await screen.findByRole("group", { name: "Pixel 8 from your Sikemux account wants to connect" });
        expect(request).toHaveTextContent("Android · key " + PHONE.slice(0, 8) + " · signed in to your account");
        await user.click(screen.getByRole("button", { name: "Decline" }));

        expect(answer).toHaveBeenCalledWith({ id: "join-1", allow: false, access: "full" }, expect.anything());
    });

    it("revokes a paired device", async () => {
        const user = userEvent.setup();
        const device = { id: PHONE, name: "Phone", platform: "android", access: "full" as const, pairedAt: 1, lastSeen: Date.now() };
        transport.register("remote_status", () => status({ devices: [device], connected: [PHONE] }));
        const revoke = vi.fn(() => status());
        transport.register("remote_revoke_device", revoke);
        render(<DevicesPage />);

        expect(await screen.findByText("Android · connected now")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /Revoke/ }));

        expect(revoke).toHaveBeenCalledWith({ id: PHONE }, expect.anything());
        expect(await screen.findByText(/No devices yet/)).toBeInTheDocument();
    });
});

describe("DevicesPage and the account", () => {
    it("drops a phone the account revoked as soon as the host hears", async () => {
        const phone = { id: PHONE, name: "Phone", platform: "ios", access: "full" as const, pairedAt: 1, lastSeen: null };
        transport.register("remote_status", () => status({ devices: [phone] }));
        render(<DevicesPage />);

        expect(await screen.findByText("1 paired")).toBeInTheDocument();
        transport.emit(REMOTE_STATUS_EVENT, status({ devices: [] }));

        expect(await screen.findByText(/No devices yet/)).toBeInTheDocument();
    });

    it("shows when the connection to the account is down", async () => {
        account = SIGNED_IN;
        transport.register("remote_status", () => status({ owner: "user_2abc", account: { state: "offline", reason: null, since: 1 } }));
        render(<DevicesPage />);

        expect(await screen.findByText("offline, retrying")).toBeInTheDocument();
        transport.emit(REMOTE_STATUS_EVENT, status({ owner: "user_2abc", account: { state: "live", reason: null, since: 2 } }));
        expect(await screen.findByText("signed in")).toBeInTheDocument();
        expect(screen.getByText("Signing out takes this host off your account. Devices already paired stay paired.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete account…" })).toBeInTheDocument();
    });

    it("signs out and says why when the account lets this host go", async () => {
        account = SIGNED_IN;
        transport.register("remote_status", () => status({ owner: "user_2abc", account: { state: "live", reason: null, since: 1 } }));
        render(<DevicesPage />);

        expect(await screen.findByText("me@example.com")).toBeInTheDocument();
        account = SIGNED_OUT;
        transport.emit(REMOTE_STATUS_EVENT, status({ account: { state: "removed", reason: "account_deleted", since: 3 } }));

        expect(await screen.findByText("Your account was deleted. Devices already paired stay paired.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.getByText("signed out")).toBeInTheDocument();
    });

    it("reads the link the way the corner shows it", () => {
        expect(accountMeta(undefined, null)).toBe("checking");
        expect(accountMeta(false, null)).toBe("signed out");
        expect(accountMeta(true, null)).toBe("signed in");
        expect(accountMeta(true, { state: "connecting", reason: null, since: 1 })).toBe("connecting");
        expect(removalNote(null)).toBeNull();
        expect(removalNote({ state: "removed", reason: null, since: 1 })).toMatch(/removed from your account at app.sikemux.com/);
    });
});

describe("seenLabel", () => {
    it("says when a device was last seen in the largest whole unit", () => {
        const now = Date.UTC(2026, 9, 2, 12);
        expect(seenLabel(null, now)).toBe("never connected");
        expect(seenLabel(now - 20_000, now)).toBe("seen just now");
        expect(seenLabel(now - 5 * 60_000, now)).toBe("seen 5 min ago");
        expect(seenLabel(now - 3 * 3_600_000, now)).toBe("seen 3 h ago");
    });

    it("signs in through the browser, then offers to sign out", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () => status());
        let finish: (value: unknown) => void = () => {};
        transport.register("account_sign_in", () => new Promise((resolve) => (finish = resolve)));
        transport.register("account_sign_out", () => SIGNED_OUT);
        render(<DevicesPage />);

        await user.click(await screen.findByRole("button", { name: "Sign in" }));
        expect(await screen.findByText("Finish signing in in your browser")).toBeInTheDocument();
        finish({ signedIn: true, userId: "user_2abc", email: "me@example.com", name: null, picture: null });

        expect(await screen.findByText("me@example.com")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Sign out" }));
        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });

    it("lets the person give up on a sign-in left open in the browser", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () => status());
        let fail: (error: unknown) => void = () => {};
        transport.register("account_sign_in", () => new Promise((_, reject) => (fail = reject)));
        const cancel = vi.fn(() => {
            fail(new Error("sign-in was cancelled"));
        });
        transport.register("account_cancel_sign_in", cancel);
        render(<DevicesPage />);

        await user.click(await screen.findByRole("button", { name: "Sign in" }));
        await user.click(await screen.findByRole("button", { name: "Cancel" }));

        expect(cancel).toHaveBeenCalled();
        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });
});

describe("DevicesPage and notifications", () => {
    const phone = { id: PHONE, name: "Pixel", platform: "android", access: "watch" as const, pairedAt: 1, lastSeen: null };

    it("says beside each phone whether its notifications reach it", async () => {
        transport.register("remote_status", () => status({ devices: [phone], notifications: [{ deviceId: PHONE, state: "notReaching", since: 1 }] }));
        render(<DevicesPage />);
        expect(await screen.findByText("notifications aren't reaching it")).toHaveClass("device-warning");
    });

    it("says nothing of notifications for a phone that never asked", async () => {
        transport.register("remote_status", () => status({ devices: [phone] }));
        render(<DevicesPage />);
        expect(await screen.findByText("Pixel")).toBeInTheDocument();
        expect(screen.queryByText(/notifications/)).not.toBeInTheDocument();
    });

    it("reads each state the way the row shows it", () => {
        expect(notificationNote("on")).toBe("notifications on");
        expect(notificationNote("phoneOff")).toBe("notifications turned off on the phone");
        expect(notificationNote("signedOut")).toBe("sign in to send it notifications");
        expect(notificationNote(undefined)).toBeNull();
    });
});
