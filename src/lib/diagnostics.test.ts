import { describe, expect, it, vi } from "vitest";
import { MemoryIpcTransport, installIpcTransportForTests } from "../api/transport";
import { MAX_RUNTIME_ERROR_MESSAGE_CHARACTERS, NATIVE_UI_HEARTBEAT_COMMAND, sanitizeRuntimeErrorMessage, sendNativeUiHeartbeat } from "./diagnostics";

describe("runtime diagnostics error capture", () => {
    it("bounds and sanitizes strings before retaining them", () => {
        const message = sanitizeRuntimeErrorMessage(`\u001b[31mfailed\u001b[0m\n${"secret".repeat(300)}`);

        expect(message).toMatch(/^failed /u);
        expect(message).not.toContain("\u001b");
        expect(message.length).toBeLessThanOrEqual(MAX_RUNTIME_ERROR_MESSAGE_CHARACTERS);
    });

    it("reads only an own scalar message and never invokes hostile accessors or coercion", () => {
        const messageGetter = vi.fn(() => "must not run");
        const toString = vi.fn(() => "must not run");
        const hostile = Object.create(null, {
            message: { enumerable: true, get: messageGetter },
            toString: { enumerable: true, value: toString },
        });

        expect(sanitizeRuntimeErrorMessage(hostile)).toBe("Unhandled runtime error");
        expect(messageGetter).not.toHaveBeenCalled();
        expect(toString).not.toHaveBeenCalled();
        expect(sanitizeRuntimeErrorMessage(Object.assign(new Error(), { message: "safe message" }))).toBe("safe message");
    });
});

describe("native UI heartbeat transport", () => {
    it("sends only the exact scalar watchdog contract without traced invoke metadata", async () => {
        const transport = new MemoryIpcTransport();
        const received: unknown[] = [];
        transport.register(NATIVE_UI_HEARTBEAT_COMMAND, (args) => {
            received.push(args);
        });
        const restore = installIpcTransportForTests(transport);
        try {
            await sendNativeUiHeartbeat(false, 17);
            expect(received).toEqual([{ visible: false, heartbeat: 17 }]);
            await expect(sendNativeUiHeartbeat(true, 0)).rejects.toThrow("positive u32");
            await expect(sendNativeUiHeartbeat(true, 0x1_0000_0000)).rejects.toThrow("positive u32");
            expect(received).toHaveLength(1);
        } finally {
            restore();
        }
    });
});
