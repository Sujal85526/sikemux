import { simApi, type SimStreamFormat } from "../api/sim";
import { avcDescription, codecName, isKeyFrame, lengthPrefixed, PPS, SPS, splitUnits, unitType } from "./h264";

export type DecoderChoice = { kind: "annexb"; config: VideoDecoderConfig } | { kind: "avcc"; config: VideoDecoderConfig } | { kind: "mjpeg" };

/** Frames as they come where the decoder takes them; otherwise length-prefixed with an avcC description; otherwise MJPEG. */
export async function chooseDecoder(
    sps: Uint8Array,
    pps: Uint8Array,
    isSupported: (config: VideoDecoderConfig) => Promise<boolean>,
): Promise<DecoderChoice> {
    const codec = codecName(sps);
    const annexb: VideoDecoderConfig = { codec, optimizeForLatency: true };
    if (await isSupported(annexb)) return { kind: "annexb", config: annexb };
    const avcc: VideoDecoderConfig = { codec, optimizeForLatency: true, description: avcDescription(sps, pps) };
    if (await isSupported(avcc)) return { kind: "avcc", config: avcc };
    return { kind: "mjpeg" };
}

const webCodecsSupports = async (config: VideoDecoderConfig) =>
    typeof VideoDecoder !== "undefined" && (await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported === true;

/** Frames waiting in the decoder past which the stream skips ahead to the next key frame rather than fall further behind. */
const DECODE_BACKLOG = 3;

export interface ScreenStreamEvents {
    /** Frames drawn in the last second. */
    onFps?: (fps: number) => void;
    /** From a touch going out to the next frame drawn, in milliseconds. */
    onLatency?: (ms: number) => void;
    onFormat?: (format: SimStreamFormat) => void;
    onError: (message: string) => void;
}

export interface ScreenPlayer {
    stop: () => void;
    markInput: () => void;
}

/**
 * Plays a device's screen into a canvas until stopped. The frames come through
 * the app on a Tauri channel. Nothing else depends on it: taps, screenshots and
 * the accessibility tree work with no stream running.
 */
export function playScreen(udid: string, canvas: HTMLCanvasElement, events: ScreenStreamEvents): ScreenPlayer {
    const context = canvas.getContext("2d");
    let stopped = false;
    let watch: Promise<number> | null = null;
    let inputAt: number | null = null;
    let decoder: VideoDecoder | null = null;
    let choice: DecoderChoice | null = null;
    let configuring = false;
    let waitingForKey = false;
    let decodingImage = false;
    let format: SimStreamFormat = "h264";
    let drawn = 0;
    const onFps = events.onFps;
    const fpsTimer = onFps
        ? window.setInterval(() => {
              onFps(drawn);
              drawn = 0;
          }, 1000)
        : null;

    const draw = (image: CanvasImageSource, width: number, height: number) => {
        if (!context || stopped) return;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        context.drawImage(image, 0, 0, width, height);
        drawn += 1;
        if (inputAt !== null) {
            events.onLatency?.(performance.now() - inputAt);
            inputAt = null;
        }
    };

    const open = async (wanted: SimStreamFormat) => {
        format = wanted;
        events.onFormat?.(wanted);
        watch = simApi.watch(udid, wanted, (frame) => void receive(frame));
        await watch;
    };

    const close = () => {
        if (!watch) return;
        void watch.then((id) => simApi.unwatch(id)).catch(() => {});
        watch = null;
    };

    const closeDecoder = () => {
        if (decoder && decoder.state !== "closed") decoder.close();
        decoder = null;
    };

    const fallBackToMjpeg = (reason: string) => {
        if (format === "mjpeg" || stopped) return;
        console.warn(`simulator screen: ${reason}; showing MJPEG instead`);
        closeDecoder();
        close();
        void open("mjpeg").catch((error) => events.onError(String(error)));
    };

    const drawJpeg = async (frame: ArrayBuffer) => {
        if (decodingImage) return;
        decodingImage = true;
        try {
            const image = await createImageBitmap(new Blob([frame], { type: "image/jpeg" }));
            draw(image, image.width, image.height);
            image.close();
        } finally {
            decodingImage = false;
        }
    };

    const startDecoder = async (sps: Uint8Array, pps: Uint8Array) => {
        configuring = true;
        choice = await chooseDecoder(sps, pps, webCodecsSupports);
        if (stopped) return false;
        if (choice.kind === "mjpeg") {
            fallBackToMjpeg("no H.264 decoder for this stream");
            return false;
        }
        decoder = new VideoDecoder({
            output: (frame) => {
                draw(frame, frame.displayWidth, frame.displayHeight);
                frame.close();
            },
            error: (error) => fallBackToMjpeg(`the H.264 decoder failed: ${error.message}`),
        });
        decoder.configure(choice.config);
        return true;
    };

    const receive = async (frame: ArrayBuffer) => {
        if (stopped) return;
        if (format === "mjpeg") return drawJpeg(frame);
        const bytes = new Uint8Array(frame);
        const units = splitUnits(bytes);
        const key = isKeyFrame(units);
        if (!decoder) {
            const sps = units.find((unit) => unitType(unit) === SPS);
            const pps = units.find((unit) => unitType(unit) === PPS);
            if (!key || !sps || !pps || configuring) return;
            if (!(await startDecoder(sps, pps))) return;
        }
        if (!decoder || decoder.state !== "configured") return;
        if (!key && (waitingForKey || decoder.decodeQueueSize >= DECODE_BACKLOG)) {
            waitingForKey = true;
            return;
        }
        waitingForKey = false;
        try {
            decoder.decode(
                new EncodedVideoChunk({
                    type: key ? "key" : "delta",
                    timestamp: Math.round(performance.now() * 1000),
                    data: choice?.kind === "avcc" ? lengthPrefixed(units) : bytes,
                }),
            );
        } catch (error) {
            fallBackToMjpeg(`the H.264 decoder refused a frame: ${String(error)}`);
        }
    };

    void open("h264").catch((error) => events.onError(String(error)));

    return {
        stop: () => {
            stopped = true;
            if (fpsTimer !== null) window.clearInterval(fpsTimer);
            close();
            closeDecoder();
        },
        markInput: () => {
            inputAt = performance.now();
        },
    };
}
