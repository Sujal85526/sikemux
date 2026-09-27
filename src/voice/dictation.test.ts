import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTextInsert } from "../state/textInsertRegistry";

const api = vi.hoisted(() => ({
    status: vi.fn(async () => ({ supported: true, installed: true, reason: null })),
    prepare: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    subscribe: vi.fn(async () => () => {}),
}));
vi.mock("../api/voice", () => ({ voiceApi: api }));

const { handleVoiceEvent, onVoiceKeyDown, onVoiceKeyUp, useVoice } = await import("./dictation");

const key = (type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) => new KeyboardEvent(type, { code, ...init });

function mountTarget() {
    const host = document.createElement("div");
    host.tabIndex = 0;
    host.getBoundingClientRect = () => ({ width: 100, height: 100 }) as DOMRect;
    document.body.append(host);
    const inserted: string[] = [];
    const unregister = registerTextInsert(host, (text) => inserted.push(text));
    host.focus();
    return { host, inserted, unregister };
}

describe("voice dictation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useVoice.setState({ phase: "ready", reason: null, stage: null, fraction: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        document.body.replaceChildren();
    });

    it("records while right Option is held and types the transcript where focus was", () => {
        const { inserted } = mountTarget();
        onVoiceKeyDown(key("keydown", "AltRight"));
        vi.advanceTimersByTime(200);
        expect(api.start).toHaveBeenCalledOnce();
        handleVoiceEvent({ type: "listening" });
        expect(useVoice.getState().phase).toBe("listening");

        onVoiceKeyUp(key("keyup", "AltRight"));
        expect(api.stop).toHaveBeenCalledOnce();
        expect(useVoice.getState().phase).toBe("transcribing");

        handleVoiceEvent({ type: "transcript", text: "run the tests" });
        expect(inserted).toEqual(["run the tests"]);
        expect(useVoice.getState().phase).toBe("ready");
    });

    it("never opens the microphone for a quick tap", () => {
        mountTarget();
        onVoiceKeyDown(key("keydown", "AltRight"));
        onVoiceKeyUp(key("keyup", "AltRight"));
        vi.advanceTimersByTime(500);
        expect(api.start).not.toHaveBeenCalled();
        expect(api.stop).not.toHaveBeenCalled();
    });

    it("treats right Option with another key as a shortcut and cancels the recording", () => {
        mountTarget();
        onVoiceKeyDown(key("keydown", "AltRight"));
        vi.advanceTimersByTime(200);
        onVoiceKeyDown(key("keydown", "KeyB", { altKey: true }));
        expect(api.cancel).toHaveBeenCalledOnce();
        onVoiceKeyUp(key("keyup", "AltRight"));
        expect(api.stop).not.toHaveBeenCalled();
    });

    it("ignores the key while the model is still downloading", () => {
        useVoice.setState({ phase: "preparing", stage: "download", fraction: 0.4 });
        onVoiceKeyDown(key("keydown", "AltRight"));
        vi.advanceTimersByTime(200);
        expect(api.start).not.toHaveBeenCalled();
    });

    it("reports download progress and readiness", () => {
        handleVoiceEvent({ type: "progress", stage: "download", fraction: 0.25 });
        expect(useVoice.getState()).toMatchObject({ phase: "preparing", stage: "download", fraction: 0.25 });
        handleVoiceEvent({ type: "ready" });
        expect(useVoice.getState()).toMatchObject({ phase: "ready", stage: null });
    });
});
