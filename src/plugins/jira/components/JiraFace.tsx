import { useEffect, useState } from "react";
import { jiraApi, type JiraPerson } from "../api";

/** The person's Jira picture, or their initials until it loads or when it cannot. */
export function JiraFace({ person }: { person: Pick<JiraPerson, "name" | "avatarUrl"> }) {
    const [picture, setPicture] = useState<{ url: string; data: string } | null>(null);
    useEffect(() => {
        const url = person.avatarUrl;
        if (!url) return;
        let live = true;
        jiraApi
            .avatar(url)
            .then((data) => live && setPicture({ url, data }))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [person.avatarUrl]);
    if (picture && picture.url === person.avatarUrl) return <img className="jira-face" src={picture.data} alt="" draggable={false} />;
    return <>{initials(person.name)}</>;
}

function initials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
}
