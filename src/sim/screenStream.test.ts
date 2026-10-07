import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simApi } from "../api/sim";
import { playScreen } from "./screenStream";

vi.mock("../api/sim", () => ({
    simApi: { watch: vi.fn(), unwatch: vi.fn(), stopStream: vi.fn() },
}));

const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
const keyFrame = Uint8Array.of(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0x88).buffer;
const deltaFrame = Uint8Array.of(0, 0, 0, 1, 0x41, 0x9a).buffer;

class FakeDecoder {
    static made: FakeDecoder[] = [];
    static isConfigSupported = vi.fn<(config: VideoDecoderConfig) => Promise<{ supported: boolean }>>();
    state = "unconfigured";
    decodeQueueSize = 0;
    decoded: string[] = [];
    constructor() {
        FakeDecoder.made.push(this);
    }
    configure() {
        this.state = "configured";
    }
    decode(chunk: { type: string }) {
        this.decoded.push(chunk.type);
    }
    close() {
        this.state = "closed";
    }
}

let sendFrame: (frame: ArrayBuffer) => void = () => {};

beforeEach(() => {
    FakeDecoder.made = [];
    FakeDecoder.isConfigSupported.mockResolvedValue({ supported: true });
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal(
        "EncodedVideoChunk",
        class {
            type: string;
            constructor(init: { type: string }) {
                this.type = init.type;
            }
        },
    );
    vi.mocked(simApi.watch).mockImplementation((_udid, _format, onFrame) => {
        sendFrame = onFrame;
        return Promise.resolve(7);
    });
    vi.mocked(simApi.unwatch).mockResolvedValue(undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("playing a device's screen", () => {
    it("leaves the stream to the helper when it stops, and only stops watching", async () => {
        const player = playScreen("UDID", canvas, { onError: vi.fn() });
        await settle();
        player.stop();
        await settle();
        expect(simApi.unwatch).toHaveBeenCalledWith(7);
        expect(simApi.stopStream).not.toHaveBeenCalled();
    });

    it("makes no decoder when it stops while one is being chosen", async () => {
        let answer: (value: { supported: boolean }) => void = () => {};
        FakeDecoder.isConfigSupported.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const player = playScreen("UDID", canvas, { onError: vi.fn() });
        await settle();
        sendFrame(keyFrame);
        player.stop();
        answer({ supported: true });
        await settle();
        expect(FakeDecoder.made).toEqual([]);
    });

    it("skips ahead to the next key frame while the decoder is behind", async () => {
        playScreen("UDID", canvas, { onError: vi.fn() });
        await settle();
        sendFrame(keyFrame);
        await settle();
        const decoder = FakeDecoder.made[0];
        decoder.decodeQueueSize = 5;
        sendFrame(deltaFrame);
        decoder.decodeQueueSize = 0;
        sendFrame(deltaFrame);
        sendFrame(keyFrame);
        sendFrame(deltaFrame);
        await settle();
        expect(decoder.decoded).toEqual(["key", "key", "delta"]);
    });
});
