import { useState } from "react";
import { basename } from "../lib/paths";
import { showImage } from "../state/imageViewer";

/* The transcript unmounts rows scrolled far away; a picture coming back holds
   its last height until it decodes again, so the rows around it do not move.
   Keyed by a slice of the source, since a screenshot's data URL is megabytes. */
const shownHeights = new Map<string, number>();
const MAX_SHOWN = 256;

function heightKey(src: string): string {
    const middle = Math.floor(src.length / 2);
    return `${src.length}:${src.slice(0, 48)}:${src.slice(middle, middle + 48)}`;
}

function rememberHeight(key: string, height: number) {
    shownHeights.delete(key);
    shownHeights.set(key, height);
    const oldest = shownHeights.keys().next();
    if (shownHeights.size > MAX_SHOWN && !oldest.done) shownHeights.delete(oldest.value);
}

/* Every picture in a transcript is a thumbnail of itself: it opens at the size
   the window allows, where it can also be saved. */
export function ChatImage({
    src,
    path,
    name = path ? basename(path) : "image.png",
    className = "chat-image",
}: {
    src: string;
    path?: string;
    name?: string;
    className?: string;
}) {
    const key = heightKey(src);
    const [loaded, setLoaded] = useState<string | null>(null);
    const held = loaded === key ? undefined : shownHeights.get(key);
    return (
        <button type="button" className="chat-image-button" title={path ?? name} onClick={() => showImage({ src, name, path })}>
            <img
                className={className}
                alt={name}
                src={src}
                style={held === undefined ? undefined : { minHeight: held }}
                onLoad={(event) => {
                    event.currentTarget.style.minHeight = "";
                    rememberHeight(key, event.currentTarget.offsetHeight);
                    setLoaded(key);
                }}
            />
        </button>
    );
}
