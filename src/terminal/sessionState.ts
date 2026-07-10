export type InitialReplayScrollState = "pending" | "user-gestured" | "complete";

export interface SerializedNormalBuffer {
    ptyId: number;
    data: string;
}

interface NormalBufferSerializer {
    serialize(options: { excludeAltBuffer: boolean; scrollback: number }): string;
}

export function initialReplayScrollState(): InitialReplayScrollState {
    return "pending";
}

export function noteUserViewportGesture(state: InitialReplayScrollState): InitialReplayScrollState {
    return state === "pending" ? "user-gestured" : state;
}

export function completeInitialReplay(state: InitialReplayScrollState): {
    state: InitialReplayScrollState;
    shouldScrollToBottom: boolean;
} {
    return {
        state: "complete",
        shouldScrollToBottom: state === "pending",
    };
}

export function serializeNormalBuffer(serializer: NormalBufferSerializer, ptyId: number, scrollback: number): SerializedNormalBuffer {
    return {
        ptyId,
        data: serializer.serialize({ excludeAltBuffer: true, scrollback }),
    };
}

export function replaySerializedNormalBuffer(saved: SerializedNormalBuffer | null, ptyId: number, alternateScreen: boolean): string | null {
    if (!alternateScreen || saved?.ptyId !== ptyId) return null;
    return saved.data;
}
