import { useState, type ReactNode } from "react";
import { notify, reportError } from "../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../plugin-api/resources";
import { IconCheck, Tooltip } from "../../plugin-api/ui";
import { useAccount, useHost, type CodeHost, type HostAccountEntry } from "../registry";
import { accountsR, hostStatusR } from "../resources";
import { forgetAccount, SECTIONS, setProjectAccount, type Section } from "../state";
import { SectionIcon, SignOutIcon } from "./ActionsIcon";
import { Avatar, Initial } from "./Pictures";
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

/** The sections this host has, in the order they sit in the git pane's header. */
export function sectionsOf(host: CodeHost): Section[] {
    const { capabilities } = host;
    return SECTIONS.filter((section) =>
        section === "issues" ? capabilities.issues : section === "releases" ? capabilities.releases : section === "inbox" ? capabilities.inbox : true,
    );
}

/** One of the local workbench's screens, handed to the navigation by the git pane. */
export interface NavItem {
    id: string;
    label: string;
    shortcut?: string;
    icon: ReactNode;
    count?: number;
    on: boolean;
    onSelect: () => void;
}

function NavTab({
    label,
    shortcut,
    on,
    count,
    onClick,
    children,
}: {
    label: string;
    shortcut?: string;
    on: boolean;
    count?: number;
    onClick: () => void;
    children: ReactNode;
}) {
    const name = shortcut ? `${label} (${shortcut})` : label;
    return (
        <Tooltip label={name}>
            <button
                type="button"
                className="git-nav-tab"
                aria-label={name}
                aria-current={on ? "page" : undefined}
                data-on={on ? "1" : "0"}
                onClick={onClick}>
                {children}
                <span className="git-nav-label">{label}</span>
                {!!count && <span className="git-nav-count">{count > 99 ? "99+" : count}</span>}
            </button>
        </Tooltip>
    );
}

/**
 * The git pane's header: the local screens, then the code host's sections, then the local screen's own controls
 * and, at the far end, who is signed in.
 */
export function GitNav({ local, host, tools, account }: { local: readonly NavItem[]; host?: ReactNode; tools?: ReactNode; account?: ReactNode }) {
    return (
        <div className="git-nav-bar">
            <nav className="git-nav" aria-label="Git">
                {local.map((item) => (
                    <NavTab key={item.id} label={item.label} shortcut={item.shortcut} on={item.on} count={item.count} onClick={item.onSelect}>
                        {item.icon}
                    </NavTab>
                ))}
                {host}
            </nav>
            <div className="git-nav-tools">{tools}</div>
            {account}
        </div>
    );
}

function AccountRow({ entry, current, onPick }: { entry: HostAccountEntry; current: boolean; onPick: () => void }) {
    return (
        <button
            type="button"
            className={`env-dd-item host-account-row${current ? " active" : ""}`}
            role="menuitemradio"
            aria-checked={current}
            onClick={onPick}>
            {entry.avatarUrl ? <Avatar url={entry.avatarUrl} login={entry.login} /> : <Initial login={entry.login} />}
            <span className="host-account-name">
                {entry.login}
                {entry.detail && <span className="host-account-detail">{entry.detail}</span>}
            </span>
            {current && <IconCheck size={12} />}
        </button>
    );
}

/** The code host's sections, after the local screens. */
export function HostNavItems({ area, onArea }: { area: string; onArea: (section: Section) => void }) {
    const host = useHost();
    return (
        <>
            <span className="git-nav-sep" />
            {sectionsOf(host).map((section) => (
                <NavTab key={section} label={sectionLabel(host, section)} on={area === section} onClick={() => onArea(section)}>
                    <SectionIcon section={section} size={14} />
                </NavTab>
            ))}
        </>
    );
}

/** Who is signed in to the code host, with the menu to switch accounts or repositories. */
export function HostAccountButton({
    slug,
    cwd,
    active,
    onSignIn,
    onPickRepo,
    onAddAccount,
}: {
    slug: string | null;
    /** The project folder, which remembers the account picked for it. */
    cwd: string;
    active: boolean;
    onSignIn: () => void;
    onPickRepo: () => void;
    onAddAccount: () => void;
}) {
    const host = useHost();
    const chosen = useAccount();
    const status = useResourceEnabled(active, hostStatusR, host.id, chosen);
    const account = status.data;
    const [menuOpen, setMenuOpen] = useState(false);
    const accounts = useResourceEnabled(active && menuOpen, accountsR, host.id).data ?? [];
    const current = account?.id ?? null;
    const isDefault = accounts.find((entry) => entry.id === current)?.isDefault ?? true;

    const act = (work: () => void) => {
        setMenuOpen(false);
        work();
    };

    const signOut = () =>
        host.api
            .signOut(current)
            .then(() => {
                if (current) forgetAccount(host.id, current);
                notify("success", `Signed ${account?.login ?? "out"} out of ${host.name}`);
                invalidate((kind) => kind.startsWith("host."));
            })
            .catch(reportError("Could not sign out"));

    const makeDefault = () =>
        current &&
        host.api
            .setDefaultAccount(current)
            .then(() => {
                notify("success", `New projects open as ${account?.login ?? "this account"}`);
                invalidate((kind) => kind === "host.accounts" || kind === "host.accountFor");
            })
            .catch(reportError("Could not change the default account"));

    return (
        <span className="git-nav-account">
            {account?.ok ? (
                <Tooltip label={`${account.login} on ${host.name}${slug ? ` · ${slug}` : ""}`}>
                    <button
                        type="button"
                        className="git-nav-avatar"
                        aria-label={`${host.name} account`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((was) => !was)}>
                        {account.avatarUrl ? <Avatar url={account.avatarUrl} /> : host.icon(16)}
                    </button>
                </Tooltip>
            ) : (
                <Tooltip label={`Sign in to ${host.name}`}>
                    <button type="button" className="git-nav-avatar" aria-label={`Sign in to ${host.name}`} onClick={onSignIn}>
                        {host.icon(14)}
                    </button>
                </Tooltip>
            )}
            {menuOpen && account?.ok && (
                <>
                    <div className="env-dd-scrim" onClick={() => setMenuOpen(false)} />
                    <div className="env-dd-menu git-nav-menu" role="menu">
                        <div className="host-account-who">
                            {account.login} on {account.host}
                            {slug && <div className="git-nav-repo">{slug}</div>}
                        </div>
                        {account.warning && <div className="host-account-warning">{account.warning}</div>}
                        {accounts.length > 1 &&
                            accounts.map((entry) => (
                                <AccountRow
                                    key={entry.id}
                                    entry={entry}
                                    current={entry.id === current}
                                    onPick={() => act(() => setProjectAccount(host.id, cwd, entry.id))}
                                />
                            ))}
                        <button type="button" className="env-dd-item" role="menuitem" onClick={() => act(onAddAccount)}>
                            Add another account…
                        </button>
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
                        {accounts.length > 1 && !isDefault && (
                            <button type="button" className="env-dd-item" role="menuitem" onClick={() => act(() => void makeDefault())}>
                                Open new projects as {account.login}
                            </button>
                        )}
                        <button type="button" className="env-dd-item" role="menuitem" onClick={() => act(() => void signOut())}>
                            <SignOutIcon size={12} /> Sign {account.login} out
                        </button>
                    </div>
                </>
            )}
        </span>
    );
}
