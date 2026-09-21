// WebGL rounds the cell down to a whole screen pixel, so letters 7.8 pixels
// wide get a 7.5 pixel cell and the line looks squeezed. letterSpacing is added
// to that rounded-down width, so one pixel back lands the cell on whichever
// whole pixel is nearest the real width.
export function cellWidthCorrection(charWidth: number, devicePixelRatio: number): number {
    if (!Number.isFinite(charWidth) || charWidth <= 0) return 0;
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 0;
    const exact = charWidth * devicePixelRatio;
    return Math.round(exact) - Math.floor(exact);
}

const measured = new Map<string, number>();

// Measured the way xterm measures it, so the correction matches what it rounds.
export function measureCharWidth(fontFamily: string, fontSize: number): number {
    const font = `${fontSize}px ${fontFamily}`;
    const cached = measured.get(font);
    if (cached !== undefined) return cached;
    let width = 0;
    try {
        const ctx = new OffscreenCanvas(100, 100).getContext("2d");
        if (ctx) {
            ctx.font = font;
            width = ctx.measureText("W").width;
        }
    } catch {
        width = 0;
    }
    // A terminal that booted before the font arrived would cache the fallback.
    if (width > 0) measured.set(font, width);
    return width;
}
