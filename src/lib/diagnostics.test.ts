import { describe, expect, it, vi } from "vitest";
import { MAX_RUNTIME_ERROR_MESSAGE_CHARACTERS, sanitizeRuntimeErrorMessage } from "./diagnostics";

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
