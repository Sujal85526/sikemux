import { createContext, useContext } from "react";
import { usePaneImage } from "../lib/paneImage";
import { useShaderField } from "../hooks/useShaderField";
import type { ShaderFieldPreset } from "../lib/shaderField";

/**
 * An empty element for a Paper Shaders field to paint into.
 *
 * Decoration only, and never a layout participant — every surface is styled to
 * look deliberate with no canvas in it, because the budget may be spent or the
 * machine may have no WebGL.
 */
export function ShaderField({
    preset,
    className,
    enabled = true,
    image = null,
}: {
    preset: ShaderFieldPreset;
    className: string;
    enabled?: boolean;
    image?: HTMLImageElement | null;
}) {
    const ref = useShaderField<HTMLDivElement>(preset, enabled, image);
    return <div className={className} aria-hidden="true" ref={ref} />;
}

/** Whether the screen a pane sits on is on the stage, standing still or sliding. */
export const PanePaintedContext = createContext(true);

/**
 * The grain behind a pane, or the reader's picture in its place when one is set.
 *
 * It lives for as long as its screen is on the stage, not for as long as the
 * screen is the one being read: a swipe hands that over halfway across, and a
 * field dropped or started there blinks on a screen still in full view.
 */
export function PaneField({ enabled }: { enabled: boolean }) {
    const image = usePaneImage();
    const painted = useContext(PanePaintedContext);
    const field = image ? "image" : "ambient";
    return <ShaderField preset={field} className={`pane-field pane-field-${field}`} enabled={enabled && painted} image={image} />;
}
