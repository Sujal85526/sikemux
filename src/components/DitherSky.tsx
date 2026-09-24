import { useLayoutEffect, useRef } from "react";
import { currentTheme, subscribeTheme } from "../themes/bus";
import type { Theme } from "../themes";

const BAYER = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33,
    9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const DOT = 3;
type Rgb = [number, number, number];

function toRgb(color: string): Rgb | null {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
}

function along(stops: Rgb[], t: number): Rgb {
    const span = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(span));
    const k = span - i;
    return stops[i].map((value, channel) => Math.round(value + (stops[i + 1][channel] - value) * k)) as Rgb;
}

/** How full the sky is at a point: dense along the top edge, rippling across, gone by the bottom. */
function density(u: number, v: number): number {
    return Math.pow(Math.max(0, 1 - v * 1.05), 1.9) * (0.55 + 0.45 * Math.sin(u * 4.2 + 0.4));
}

function paint(canvas: HTMLCanvasElement, theme: Theme): void {
    const ctx = canvas.getContext("2d");
    const stops = [theme.chrome.acc, theme.highlight.function, theme.highlight.string].map(toRgb);
    if (!ctx || stops.some((stop) => !stop)) return;
    const width = Math.max(1, Math.ceil(canvas.clientWidth / DOT));
    const height = Math.max(1, Math.ceil(canvas.clientHeight / DOT));
    canvas.width = width;
    canvas.height = height;
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = x / Math.max(1, width - 1);
            if (density(u, y / Math.max(1, height - 1)) <= (BAYER[(y % 8) * 8 + (x % 8)] + 0.5) / 64) continue;
            image.data.set([...along(stops as Rgb[], u), 235], (y * width + x) * 4);
        }
    }
    ctx.putImageData(image, 0, 0);
}

/** An ordered-dither wash in the theme's accent, syntax pink and syntax green. */
export function DitherSky({ className }: { className: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useLayoutEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const repaint = () => paint(canvas, currentTheme());
        repaint();
        const resize = new ResizeObserver(repaint);
        resize.observe(canvas);
        const unsubscribe = subscribeTheme(repaint);
        return () => {
            resize.disconnect();
            unsubscribe();
        };
    }, []);
    return <canvas ref={ref} className={className} aria-hidden="true" />;
}
