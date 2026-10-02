import { useRef } from "react";
import { usePaneImage } from "../lib/paneImage";
import { useStageMoving } from "../state/nativeViews";
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

/** The grain behind a pane, or the reader's picture in its place when one is set. */
export function PaneField({ enabled }: { enabled: boolean }) {
    const image = usePaneImage();
    const field = image ? "image" : "ambient";
    /* A field starts by compiling its shader and stops by dropping its WebGL
       context, either of which costs a swipe frames. The screen it slides past
       is not the one being read yet, so the field waits for the stage to stop. */
    const moving = useStageMoving();
    const settled = useRef(enabled);
    if (!moving) settled.current = enabled;
    return <ShaderField preset={field} className={`pane-field pane-field-${field}`} enabled={settled.current} image={image} />;
}
