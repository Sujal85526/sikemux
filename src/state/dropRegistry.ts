export type DropPathsHandler = (paths: string[]) => void;
export type DropFolderHandler = (paths: string[]) => void;

const pathHandlers = new WeakMap<HTMLElement, DropPathsHandler>();
const folderHandlers = new WeakMap<HTMLElement, DropFolderHandler>();

export function registerPtyDrop(el: HTMLElement, fn: DropPathsHandler): () => void {
    return registerPathDrop(el, fn);
}

/** Register any UI surface that consumes native filesystem paths. */
export function registerPathDrop(el: HTMLElement, fn: DropPathsHandler): () => void {
    pathHandlers.set(el, fn);
    return () => {
        if (pathHandlers.get(el) === fn) pathHandlers.delete(el);
    };
}

export function registerFolderDrop(el: HTMLElement, fn: DropFolderHandler): () => void {
    folderHandlers.set(el, fn);
    return () => {
        folderHandlers.delete(el);
    };
}

export function dispatchPty(el: HTMLElement, paths: string[]): boolean {
    const fn = pathHandlers.get(el);
    if (!fn) return false;
    fn(paths);
    return true;
}

/** Find the nearest registered native-path consumer beneath a hit-tested node. */
export function resolvePathDropTarget(el: HTMLElement | null): HTMLElement | null {
    for (let target = el; target; target = target.parentElement) {
        if (pathHandlers.has(target)) return target;
    }
    return null;
}

/** Route a native drop from its deepest hit-tested node to the nearest owner. */
export function dispatchPathDrop(el: HTMLElement | null, paths: string[]): boolean {
    const target = resolvePathDropTarget(el);
    return target ? dispatchPty(target, paths) : false;
}

export function dispatchFolder(el: HTMLElement, paths: string[]): boolean {
    const fn = folderHandlers.get(el);
    if (!fn) return false;
    fn(paths);
    return true;
}
