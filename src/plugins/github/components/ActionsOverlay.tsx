import { lazy, Suspense, useEffect } from "react";
import { closeCorePalettes, useCorePaletteOpen, usePluginOverlay } from "../../../plugin-api/host";
import { closePalette, useActions } from "../state";

const Palette = lazy(() => import("./ActionsPalette").then((module) => ({ default: module.Palette })));

export function ActionsOverlay() {
    const open = useActions((state) => state.paletteOpen);
    const corePaletteOpen = useCorePaletteOpen();
    usePluginOverlay(open);
    useEffect(() => {
        if (corePaletteOpen) closePalette();
    }, [corePaletteOpen]);
    useEffect(() => {
        if (open) closeCorePalettes();
    }, [open]);
    if (!open) return null;
    return (
        <Suspense fallback={null}>
            <Palette />
        </Suspense>
    );
}
