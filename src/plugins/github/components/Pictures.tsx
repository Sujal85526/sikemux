import { useEffect, useState } from "react";
import { swallow } from "../../../plugin-api/host";
import { Markdown } from "../../../plugin-api/ui";
import { actionsApi } from "../api";

function usePicture(url: string): string | null {
    const [loaded, setLoaded] = useState<{ url: string; data: string } | null>(null);
    useEffect(() => {
        let alive = true;
        actionsApi
            .image(url)
            .then((data) => {
                if (alive) setLoaded({ url, data });
            })
            .catch(swallow("load an avatar"));
        return () => {
            alive = false;
        };
    }, [url]);
    return loaded?.url === url ? loaded.data : null;
}

/** An empty circle of the same size holds the place until the picture arrives, so nothing beside it moves. */
export function Avatar({ url }: { url: string }) {
    const data = usePicture(url);
    return data ? <img className="gha-avatar" src={data} alt="" width={16} height={16} /> : <span className="gha-avatar" aria-hidden="true" />;
}

export function Prose({ children, className }: { children: string; className?: string }) {
    return (
        <Markdown className={className} loadImage={actionsApi.image}>
            {children}
        </Markdown>
    );
}
