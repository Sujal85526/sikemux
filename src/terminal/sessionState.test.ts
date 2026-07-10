import { describe, expect, it, vi } from "vitest";
import {
    completeInitialReplay,
    initialReplayScrollState,
    noteUserViewportGesture,
    replaySerializedNormalBuffer,
    serializeNormalBuffer,
} from "./sessionState";

describe("initial replay scroll follow", () => {
    it("forces the untouched initial replay to the bottom", () => {
        expect(completeInitialReplay(initialReplayScrollState())).toEqual({
            state: "complete",
            shouldScrollToBottom: true,
        });
    });

    it("does not let replay completion override a later user viewport gesture", () => {
        const state = noteUserViewportGesture(initialReplayScrollState());

        expect(completeInitialReplay(state)).toEqual({
            state: "complete",
            shouldScrollToBottom: false,
        });
    });

    it("never forces the viewport after initial replay has completed", () => {
        const { state } = completeInitialReplay(initialReplayScrollState());

        expect(completeInitialReplay(state).shouldScrollToBottom).toBe(false);
    });
});

describe("normal-buffer reattach serialization", () => {
    it("serializes the normal buffer without the alternate buffer and with full configured scrollback", () => {
        const serialize = vi.fn(() => "serialized normal buffer");

        expect(serializeNormalBuffer({ serialize }, 42, 10_000)).toEqual({
            ptyId: 42,
            data: "serialized normal buffer",
        });
        expect(serialize).toHaveBeenCalledWith({
            excludeAltBuffer: true,
            scrollback: 10_000,
        });
    });

    it("replays only for the same PTY while the backend is on the alternate screen", () => {
        const saved = { ptyId: 42, data: "serialized normal buffer" };

        expect(replaySerializedNormalBuffer(saved, 42, true)).toBe(saved.data);
        expect(replaySerializedNormalBuffer(saved, 42, false)).toBeNull();
        expect(replaySerializedNormalBuffer(saved, 7, true)).toBeNull();
        expect(replaySerializedNormalBuffer(null, 42, true)).toBeNull();
    });
});
