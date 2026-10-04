import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_STATUS_EVENT, type PendingDevice, type RemoteStatus } from "../api/remote";
import { installIpcTransportForTests, MemoryIpcTransport, resetIpcTransportForTests } from "../api/transport";
import { getState, setState } from "../state/store";

const notifications = vi.hoisted(() => ({ post: vi.fn(async () => {}) }));
vi.mock("../agents/agentNotifications", () => ({ postNotification: notifications.post }));
const appWindow = vi.hoisted(() => ({ requestUserAttention: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow, UserAttentionType: { Critical: 1, Informational: 2 } }));

const { PairingPrompt } = await import("./PairingPrompt");
await import("./PairingCards");

const PHONE = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const FROM_ACCOUNT: PendingDevice = { id: "join-1", deviceId: PHONE, name: "Pixel 8", platform: "android", fromAccount: true };
const WITH_CODE: PendingDevice = { id: "request-1", deviceId: PHONE, name: "Kishore's phone", platform: "ios", fromAccount: false };

function status(pending: readonly PendingDevice[] = []): RemoteStatus {
    return {
        enabled: true,
        coreId: "core",
        addresses: [],
        devices: [],
        connected: [],
        pairing: null,
        pending,
        owner: "user_2abc",
        account: null,
        updateRequired: null,
        notifications: [],
    };
}

const initial = getState();
let transport: MemoryIpcTransport;

beforeEach(() => {
    setState(initial, true);
    transport = new MemoryIpcTransport();
    installIpcTransportForTests(transport);
    notifications.post.mockClear();
    appWindow.requestUserAttention.mockClear();
});

afterEach(() => {
    cleanup();
    resetIpcTransportForTests();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const card = (name: string) => screen.queryByRole("alertdialog", { name });
const JOIN_QUESTION = "Pixel 8 from your Sikemux account wants to connect";

describe("PairingPrompt", () => {
    it("stays out of the way while no device is waiting", async () => {
        transport.register("remote_status", () => status());
        render(<PairingPrompt hasFocus={() => true} />);
        await settle();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("asks about a phone from the account wherever the person is, and goes once the request ends", async () => {
        transport.register("remote_status", () => status());
        render(<PairingPrompt hasFocus={() => true} />);
        await settle();

        transport.emit(REMOTE_STATUS_EVENT, status([FROM_ACCOUNT]));
        const prompt = await screen.findByRole("alertdialog", { name: JOIN_QUESTION });
        expect(prompt).toHaveTextContent("Android · key " + PHONE.slice(0, 8) + " · signed in to your account");

        transport.emit(REMOTE_STATUS_EVENT, status());
        await waitFor(() => expect(card(JOIN_QUESTION)).not.toBeInTheDocument());
    });

    it("asks about a device that typed the code the same way", async () => {
        transport.register("remote_status", () => status([WITH_CODE]));
        render(<PairingPrompt hasFocus={() => true} />);
        expect(await screen.findByRole("alertdialog", { name: "Kishore's phone wants to pair" })).toBeInTheDocument();
    });

    it("leaves the question to Settings › Devices while that page is open", async () => {
        setState({ settingsOpen: true, settingsPage: "devices" });
        transport.register("remote_status", () => status([FROM_ACCOUNT]));
        render(<PairingPrompt hasFocus={() => true} />);
        await settle();
        expect(card(JOIN_QUESTION)).not.toBeInTheDocument();

        setState({ settingsPage: "general" });
        expect(await screen.findByRole("alertdialog", { name: JOIN_QUESTION })).toBeInTheDocument();
    });

    it("allows the phone with the access the person chose, and goes once answered", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () => status([FROM_ACCOUNT]));
        const answer = vi.fn(() => status());
        transport.register("remote_answer_pairing", answer);
        render(<PairingPrompt hasFocus={() => true} />);

        await screen.findByRole("alertdialog", { name: JOIN_QUESTION });
        await user.click(screen.getByRole("button", { name: /access for this device/ }));
        await user.click(await screen.findByRole("option", { name: /Watch and approve/ }));
        await user.click(screen.getByRole("button", { name: "Allow" }));

        expect(answer).toHaveBeenCalledWith({ id: "join-1", allow: true, access: "watch" }, expect.anything());
        await waitFor(() => expect(card(JOIN_QUESTION)).not.toBeInTheDocument());
    });

    it("declines the phone", async () => {
        const user = userEvent.setup();
        transport.register("remote_status", () => status([FROM_ACCOUNT]));
        const answer = vi.fn(() => status());
        transport.register("remote_answer_pairing", answer);
        render(<PairingPrompt hasFocus={() => true} />);

        await screen.findByRole("alertdialog", { name: JOIN_QUESTION });
        await user.click(screen.getByRole("button", { name: "Decline" }));

        expect(answer).toHaveBeenCalledWith({ id: "join-1", allow: false, access: "full" }, expect.anything());
        await waitFor(() => expect(card(JOIN_QUESTION)).not.toBeInTheDocument());
    });

    it("notifies once per request while Sikemux is in the background, and not while it is in front", async () => {
        let focused = true;
        transport.register("remote_status", () => status());
        render(<PairingPrompt hasFocus={() => focused} />);
        await settle();

        transport.emit(REMOTE_STATUS_EVENT, status([WITH_CODE]));
        await screen.findByRole("alertdialog", { name: "Kishore's phone wants to pair" });
        expect(notifications.post).not.toHaveBeenCalled();

        focused = false;
        transport.emit(REMOTE_STATUS_EVENT, status([WITH_CODE, FROM_ACCOUNT]));
        await screen.findByRole("alertdialog", { name: JOIN_QUESTION });
        transport.emit(REMOTE_STATUS_EVENT, status([WITH_CODE, FROM_ACCOUNT]));
        await settle();

        expect(notifications.post).toHaveBeenCalledTimes(1);
        expect(notifications.post).toHaveBeenCalledWith(
            "Pixel 8 wants to connect to this computer",
            "It is signed in to your Sikemux account. Allow or decline it in Sikemux.",
        );
        expect(appWindow.requestUserAttention).toHaveBeenCalledTimes(1);
    });
});
