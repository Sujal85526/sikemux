import { useState } from "react";
import { notify, reportError } from "../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../plugin-api/resources";
import type { GitArea } from "../../state/types";
import { useHost, type CodeHost } from "../registry";
import { hostStatusR } from "../resources";
import { SECTIONS, type Section } from "../state";
import { SectionIcon, SignOutIcon, UpDown } from "./ActionsIcon";
import { Avatar } from "./Pictures";
import "../strip.css";

export function sectionLabel(host: CodeHost, section: Section): string {
    switch (section) {
        case "pulls":
            return "Pull requests";
        case "actions":
            return host.ciName;
        case "issues":
            return "Issues";
        case "releases":
            return "Releases";
        case "inbox":
            return "Inbox";
    }
}

/** The sections this host has, in the order they sit in the strip. */
export function sectionsOf(host: CodeHost): Section[] {
    const { capabilities } = host;
    return SECTIONS.filter((section) =>
        section === "issues" ? capabilities.issues : section === "releases" ? capabilities.releases : section === "inbox" ? capabilities.inbox : true,
    );
}

interface Props {
    area: GitArea;
    slug: string | null;
    active: boolean;
    onArea: (area: GitArea) => void;
    onPickRepo: () => void;
}

/** The git pane's local workbench and the code host's sections, side by side, with the account at the end. */
export function HostStrip({ area, slug, active, onArea, onPickRepo }: Props) {
    const host = useHost();
    const status = useResourceEnabled(active, hostStatusR, host.id);
    const account = status.data;
    const [menuOpen, setMenuOpen] = useState(false);

    const signOut = () => {
        setMenuOpen(false);
        host.api
            .signOut()
            .then(() => {
                notify("success", `Signed out of ${host.name}`);
                invalidate((kind) => kind.startsWith("host."));
            })
            .catch(reportError("Could not sign out"));
    };

    return (
        <div className="host-strip">
            <div className="host-tabs" role="tablist" aria-label="Local and code host">
                <button
                    type="button"
                    role="tab"
                    className="host-tab"
                    data-on={area === "local" ? "1" : "0"}
                    aria-selected={area === "local"}
                    onClick={() => onArea("local")}>
                    Local
                </button>
                {sectionsOf(host).map((section) => (
                    <button
                        key={section}
                        type="button"
                        role="tab"
                        className="host-tab"
                        data-on={area === section ? "1" : "0"}
                        aria-selected={area === section}
                        onClick={() => onArea(section)}>
                        <SectionIcon section={section} size={13} />
                        {sectionLabel(host, section)}
                    </button>
                ))}
            </div>
            {account?.ok ? (
                <span className="host-account-anchor">
                    <button
                        type="button"
                        className="host-account"
                        onClick={() => setMenuOpen((was) => !was)}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}>
                        {host.icon(13)}
                        {slug && <span className="host-account-repo">{slug}</span>}
                        {account.avatarUrl ? <Avatar url={account.avatarUrl} /> : <span className="gha-avatar" aria-hidden="true" />}
                        <span className="host-account-login">{account.login}</span>
                        <UpDown />
                    </button>
                    {menuOpen && (
                        <>
                            <div className="env-dd-scrim" onClick={() => setMenuOpen(false)} />
                            <div className="env-dd-menu host-account-menu" role="menu">
                                <div className="host-account-who">
                                    {account.login} on {account.host}
                                </div>
                                {account.warning && <div className="host-account-warning">{account.warning}</div>}
                                <button
                                    type="button"
                                    className="env-dd-item"
                                    role="menuitem"
                                    onClick={() => {
                                        setMenuOpen(false);
                                        onPickRepo();
                                    }}>
                                    Choose another repository…
                                </button>
                                <button type="button" className="env-dd-item" role="menuitem" onClick={signOut}>
                                    <SignOutIcon size={12} /> Sign out
                                </button>
                            </div>
                        </>
                    )}
                </span>
            ) : (
                <button type="button" className="host-account" onClick={() => onArea("pulls")}>
                    {host.icon(13)} Sign in to {host.name}
                </button>
            )}
        </div>
    );
}
