const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff"]);

export function extname(path: string): string {
    const file = path.split("/").pop()?.toLowerCase() ?? "";
    const i = file.lastIndexOf(".");
    return i > 0 ? file.slice(i + 1) : "";
}

export function isImagePath(path: string | null | undefined): boolean {
    return !!path && IMAGE_EXTS.has(extname(path));
}
