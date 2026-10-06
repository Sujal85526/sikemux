import { useMemo } from "react";
import { encode } from "uqr";

/** Whole pixels per module, so every module draws the same size. */
const MODULE_PX = 6;

/** `text` as a QR code, dark on light so every phone camera reads it. The tile around it is the quiet zone. */
export function QrCode({ text, label }: { text: string; label: string }) {
    const { drawn, span } = useMemo(() => {
        const { data } = encode(text, { ecc: "M", border: 0 });
        let path = "";
        data.forEach((row, y) =>
            row.forEach((dark, x) => {
                if (dark) path += `M${x} ${y}h1v1h-1z`;
            }),
        );
        return { drawn: path, span: data.length };
    }, [text]);
    return (
        <svg
            className="qr-code"
            width={span * MODULE_PX}
            height={span * MODULE_PX}
            viewBox={`0 0 ${span} ${span}`}
            role="img"
            aria-label={label}
            shapeRendering="crispEdges">
            <path d={drawn} fill="#000" />
        </svg>
    );
}
