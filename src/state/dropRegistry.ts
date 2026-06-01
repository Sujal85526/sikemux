export type DropPathsHandler = (paths: string[]) => void;
export type DropFolderHandler = (paths: string[]) => void;

const ptyHandlers = new WeakMap<HTMLElement, DropPathsHandler>();
const folderHandlers = new WeakMap<HTMLElement, DropFolderHandler>();

export function registerPtyDrop(el: HTMLElement, fn: DropPathsHandler): () => void {
    ptyHandlers.set(el, fn);
    return () => {
        ptyHandlers.delete(el);
    };
}

export function registerFolderDrop(el: HTMLElement, fn: DropFolderHandler): () => void {
    folderHandlers.set(el, fn);
    return () => {
        folderHandlers.delete(el);
    };
}

export function dispatchPty(el: HTMLElement, paths: string[]): boolean {
    const fn = ptyHandlers.get(el);
    if (!fn) return false;
    fn(paths);
    return true;
}

export function dispatchFolder(el: HTMLElement, paths: string[]): boolean {
    const fn = folderHandlers.get(el);
    if (!fn) return false;
    fn(paths);
    return true;
}
