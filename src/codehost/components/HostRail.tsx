import { useState, type ReactNode } from "react";
import { notify, reportError } from "../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../plugin-api/resources";
import { Tooltip } from "../../plugin-api/ui";
import { useHost, type CodeHost } from "../registry";
import { hostStatusR } from "../resources";
import { SECTIONS, type Section } from "../state";
import { SectionIcon, SignOutIcon } from "./ActionsIcon";
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

/** The sections this host has, in the order they sit in the rail. */
export function sectionsOf(host: CodeHost): Section[] {
    const { capabilities } = host;
    return SECTIONS.filter((section) =>
        section === "issues" ? capabilities.issues : section === "releases" ? capabilities.releases : section === "inbox" ? capabilities.inbox : true,
    );
}

/** One of the local workbench's screens, handed to the rail by the git pane. */
export interface RailItem {
    id: string;
    label: string;
    icon: ReactNode;
    count?: number;
    on: boolean;
    onSelect: () => void;
}

function RailButton({
    label,
    on,
    count,
    onClick,
    children,
}: {
    label: string;
    on: boolean;
    count?: number;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip label={label} side="right">
            <button
                type="button"
                className="git-rail-btn"
                aria-label={label}
                aria-current={on ? "page" : undefined}
                data-on={on ? "1" : "0"}
                onClick={onClick}>
                {children}
                {!!count && <span className="git-rail-count">{count > 99 ? "99+" : count}</span>}
            </button>
        </Tooltip>
    );
}

/** The git pane's one navigation: the local screens, then the code host's sections, with the account at the foot. */
export function GitRail({ local, host }: { local: readonly RailItem[]; host: ReactNode }) {
    return (
        <nav className="git-rail" aria-label="Git">
            {local.map((item) => (
                <RailButton key={item.id} label={item.label} on={item.on} count={item.count} onClick={item.onSelect}>
                    {item.icon}
                </RailButton>
            ))}
            {host}
        </nav>
    );
}

/** The code host's part of the rail: its sections and, at the foot, who is signed in. */
export function HostRailItems({
    area,
    slug,
    active,
    onArea,
    onPickRepo,
}: {
    area: string;
    slug: string | null;
    active: boolean;
    onArea: (section: Section) => void;
    onPickRepo: () => void;
}) {
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
        <>
            <span className="git-rail-sep" />
            {sectionsOf(host).map((section) => (
                <RailButton key={section} label={sectionLabel(host, section)} on={area === section} onClick={() => onArea(section)}>
                    <SectionIcon section={section} size={16} />
                </RailButton>
            ))}
            <span className="git-rail-foot">
                {account?.ok ? (
                    <Tooltip label={`${account.login} on ${host.name}${slug ? ` · ${slug}` : ""}`} side="right">
                        <button
                            type="button"
                            className="git-rail-btn git-rail-account"
                            aria-label={`${host.name} account`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() => setMenuOpen((was) => !was)}>
                            {account.avatarUrl ? <Avatar url={account.avatarUrl} /> : host.icon(16)}
                        </button>
                    </Tooltip>
                ) : (
                    <RailButton label={`Sign in to ${host.name}`} on={false} onClick={() => onArea("pulls")}>
                        {host.icon(16)}
                    </RailButton>
                )}
                {menuOpen && account?.ok && (
                    <>
                        <div className="env-dd-scrim" onClick={() => setMenuOpen(false)} />
                        <div className="env-dd-menu git-rail-menu" role="menu">
                            <div className="host-account-who">
                                {account.login} on {account.host}
                                {slug && <div className="git-rail-repo">{slug}</div>}
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
        </>
    );
}
