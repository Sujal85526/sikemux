import { useEffect, useState } from "react";
import { IconUser } from "../../../plugin-api/ui";
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

/** A person's round picture, or an empty one for nobody. */
export function Avatar({ person, large }: { person: Pick<JiraPerson, "name" | "avatarUrl"> | null; large?: boolean }) {
    const size = large ? " large" : "";
    if (!person)
        return (
            <span className={`jira-avatar nobody${size}`} title="Unassigned">
                <IconUser size={large ? 13 : 11} />
            </span>
        );
    return (
        <span className={`jira-avatar${size}`} title={person.name}>
            <JiraFace person={person} />
        </span>
    );
}
