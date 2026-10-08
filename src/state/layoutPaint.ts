import { computeLayout } from "./layout";
import type { Divider, LayoutNode, Rect } from "./types";

export const pct = (n: number) => `${n * 100}%`;

export function cellPlacement(rect: Rect) {
    return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
}

export function stackPlacement(rect: Rect) {
    return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w) };
}

export function dividerPlacement(d: Divider) {
    return d.dir === "row"
        ? { left: pct(d.rect.x + d.at * d.rect.w), top: pct(d.rect.y), height: pct(d.rect.h) }
        : { top: pct(d.rect.y + d.at * d.rect.h), left: pct(d.rect.x), width: pct(d.rect.w) };
}

export const dividerKey = (d: Divider) => `${d.splitId}:${d.index}`;

/**
 * Places a window's panes, stack strips and dividers where `root` puts them,
 * straight on the page. A move that runs every frame goes through here rather
 * than the store, and writes the store once where it lands.
 */
export function paintLayout(windowId: string, root: LayoutNode, activePaneId: string, zoomedPaneId: string | null): void {
    const layer = document.querySelector<HTMLElement>(`.window-layer[data-window-id="${CSS.escape(windowId)}"]`);
    if (!layer) return;
    const { panes, stacked, stacks, dividers } = computeLayout(root, activePaneId);
    for (const cell of layer.querySelectorAll<HTMLElement>(":scope > [data-pane-cell]")) {
        const id = cell.dataset.paneCell ?? "";
        const rect = panes.get(id) ?? stacked.get(id);
        if (rect && id !== zoomedPaneId) Object.assign(cell.style, cellPlacement(rect));
    }
    for (const stack of stacks) {
        const strip = layer.querySelector<HTMLElement>(`:scope > [data-stack="${CSS.escape(stack.splitId)}"]`);
        if (strip) Object.assign(strip.style, stackPlacement(stack.rect));
    }
    for (const d of dividers) {
        const handle = layer.querySelector<HTMLElement>(`:scope > [data-divider="${CSS.escape(dividerKey(d))}"]`);
        if (handle) Object.assign(handle.style, dividerPlacement(d));
    }
}
