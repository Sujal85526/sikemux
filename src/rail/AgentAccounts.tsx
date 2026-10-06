import { useEffect, useMemo, useState } from "react";
import { agentApi, type AgentUsage } from "../api/agents";
import { AccountSignIn } from "../agents/AccountSignIn";
import { accountsOf, signIn, signOut, useSignIn, type AccountProvider } from "../agents/accounts";
import { selectedProviderProfile } from "../agents/agentProfiles";
import * as cmd from "../state/commands";
import { fetchResource, invalidate, peekResource, type ResourceHandle, useResource } from "../state/resources";
import { agentAccountR, agentUsageR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import type { ProviderProfile } from "../state/types";
import { IconCheck, IconChevron, IconPlus, IconRefresh } from "../ui/Icons";
import { CountUp } from "../ui/RollingText";
import { Tooltip } from "../ui/Tooltip";
import { TreeContextMenu, type CtxItem } from "./FileTree";
import { planLabel, resetCountdown, resetTitle, usagePeak, usageTone } from "./usageFormat";

const ACCENTS: Record<AccountProvider, string> = { claude: "#d97757", codex: "#7a9dff" };

function useMinuteClock(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || "?";
}

/**
 * The rail's footer: the plan limits of the account new chats start on, under
 * a card that says which account that is. The card opens the person's other
 * accounts with the provider, and what can be done with them.
 */
export function AgentAccountsPanel({
    provider,
    usage,
    label,
    command,
}: {
    provider: AccountProvider;
    /** The limits of the account new chats start on, which the rail already reads. */
    usage: ResourceHandle<AgentUsage>;
    label?: string;
    command?: string;
}) {
    const profiles = useStore((s) => s.providerProfiles);
    const selections = useStore((s) => s.selectedProviderProfileIds);
    const autoSwitch = useStore((s) => s.accountAutoSwitch[provider] === true);
    const accounts = useMemo(() => accountsOf(provider, profiles), [provider, profiles]);
    const current = selectedProviderProfile(provider, profiles, selections) ?? accounts[0];
    const [adding, setAdding] = useState(false);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const providerLabel = label ?? (provider === "claude" ? "Claude" : "Codex");
    const status = useResource(agentAccountR, provider, current?.executablePath, current?.configPath);
    const signing = useSignIn(current?.id ?? "");
    const signedOut = status.data?.signedIn === false;

    /* The menu names each other account by who it is signed in as and how
       much it has used, read ahead so it is there when the menu opens. */
    const readOthers = () => {
        for (const account of accounts) {
            if (account.id === current?.id) continue;
            void fetchResource(agentAccountR, provider, account.executablePath, account.configPath)
                .then((other) => (other.signedIn ? fetchResource(agentUsageR, provider, command, account.configPath) : undefined))
                .catch(() => {});
        }
    };
    useEffect(readOthers, [accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const refresh = () => invalidate((kind, args) => (kind === "agents.account" || kind === "agents.usage") && args[0] === provider);

    if (!current) return null;
    const items = accountMenu({
        provider,
        accounts,
        current,
        command,
        signedIn: status.data?.signedIn === true,
        autoSwitch,
        onAdd: () => setAdding(true),
    });

    return (
        <section className={`agent-usage agent-accounts ${provider}`} aria-label={`${providerLabel} plan limits`}>
            <div className="panel-head agent-usage-head">
                <span className="panel-label">Limits</span>
                <span className="panel-rule" />
                <Tooltip label={`Refresh ${providerLabel} plan limits`}>
                    <button
                        type="button"
                        className="rail-group-add"
                        aria-label={`Refresh ${providerLabel} plan limits`}
                        disabled={usage.status === "loading"}
                        onClick={refresh}>
                        <IconRefresh size={11} />
                    </button>
                </Tooltip>
            </div>

            <button
                type="button"
                className="agent-account-switch"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                aria-label={`${providerLabel} account: ${current.name}`}
                onClick={(event) => {
                    readOthers();
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.left, y: box.bottom + 4 });
                }}>
                <span className="agent-account-avatar" style={{ background: current.accent }} aria-hidden="true">
                    {initial(current.name)}
                </span>
                <span className="agent-account-id">
                    <span className="agent-account-title">
                        <span className="agent-account-name">{current.name}</span>
                        {(usage.data?.plan ?? status.data?.plan) && (
                            <span className="agent-account-plan">{planLabel((usage.data?.plan ?? status.data?.plan)!)}</span>
                        )}
                    </span>
                    <span className="agent-account-who" data-signed-out={signedOut ? "true" : undefined}>
                        {signedOut ? "Signed out" : (status.data?.email ?? status.data?.organization ?? " ")}
                    </span>
                </span>
                <IconChevron size={10} className="agent-account-chevron" />
            </button>
            {menu && <TreeContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}

            {adding && <AddAccount provider={provider} providerLabel={providerLabel} onDone={() => setAdding(false)} />}
            {signedOut || signing ? <AccountSignIn profile={current} /> : <UsageWindows usage={usage} />}
        </section>
    );
}

function accountMenu({
    provider,
    accounts,
    current,
    command,
    signedIn,
    autoSwitch,
    onAdd,
}: {
    provider: AccountProvider;
    accounts: ProviderProfile[];
    current: ProviderProfile;
    command?: string;
    signedIn: boolean;
    autoSwitch: boolean;
    onAdd: () => void;
}): CtxItem[] {
    const items: CtxItem[] = accounts.map((account) => {
        if (account.id === current.id) return { label: account.name, hint: "In use", icon: <IconCheck size={11} /> };
        const status = peekResource(agentAccountR, provider, account.executablePath, account.configPath);
        const peak = usagePeak(peekResource(agentUsageR, provider, command, account.configPath));
        const hint = status && !status.signedIn ? "Signed out" : peak != null ? `${Math.round(peak)}% used` : (status?.email ?? undefined);
        return {
            label: account.name,
            hint,
            icon: (
                <span className="agent-account-avatar small" style={{ background: account.accent }}>
                    {initial(account.name)}
                </span>
            ),
            run: () => {
                cmd.selectProviderProfile(provider, account.id);
                if (status && !status.signedIn) void signIn(account);
            },
        };
    });
    items.push({ sep: true });
    if (accounts.length > 1) {
        items.push({
            label: "Move chats at a limit",
            hint: autoSwitch ? "On" : "Off",
            icon: autoSwitch ? <IconCheck size={11} /> : undefined,
            run: () => cmd.setAccountAutoSwitch(provider, !autoSwitch),
        });
    }
    items.push({ label: "Add account…", icon: <IconPlus size={11} />, run: onAdd });
    if (signedIn) items.push({ label: "Sign out", run: () => void signOut(current).catch(reportError("Sign out")) });
    else items.push({ label: "Sign in", run: () => void signIn(current) });
    items.push({ sep: true }, { label: "Account settings…", run: () => cmd.openSettings("agents") });
    if (!current.id.startsWith("builtin-"))
        items.push({ label: `Remove ${current.name}`, danger: true, run: () => cmd.deleteProviderProfile(current.id) });
    return items;
}

function UsageWindows({ usage }: { usage: ResourceHandle<AgentUsage> }) {
    const now = useMinuteClock();
    const windows = usage.data?.windows ?? [];
    if (windows.length === 0) {
        return (
            <div className="agent-usage-empty" data-loading={usage.status === "loading" ? "true" : "false"}>
                {usage.status === "loading"
                    ? "reading plan limits…"
                    : usage.status === "error"
                      ? "Could not read plan limits. Refresh to try again."
                      : (usage.data?.unavailableReason ?? "This account did not report plan limits.")}
            </div>
        );
    }
    return (
        <>
            {windows.map((window, index) => {
                const percent = Math.max(0, Math.min(100, window.usedPercent));
                const rounded = Math.round(percent);
                return (
                    <Tooltip
                        key={`${window.label}:${String(window.resetsAt)}:${index}`}
                        side="left"
                        label={`${window.label}: ${rounded}% used. ${resetTitle(window.resetsAt)}`}>
                        <div className="agent-usage-row" data-tone={usageTone(percent)}>
                            <div className="agent-usage-line">
                                <span className="agent-usage-name">{window.label}</span>
                                <span className="agent-usage-reset">{resetCountdown(window.resetsAt, now)}</span>
                            </div>
                            <div className="agent-usage-gauge">
                                <span className="agent-usage-pct">
                                    <CountUp value={rounded} />
                                    <i>%</i>
                                </span>
                                <span
                                    className="agent-usage-track"
                                    role="meter"
                                    aria-label={`${window.label} usage`}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={rounded}>
                                    <span className="agent-usage-fill" style={{ width: `${percent}%` }} />
                                </span>
                            </div>
                        </div>
                    </Tooltip>
                );
            })}
        </>
    );
}

/* A new account gets a directory of its own that shares the default one's
   chats and settings, then signs in there straight away. */
function AddAccount({ provider, providerLabel, onDone }: { provider: AccountProvider; providerLabel: string; onDone: () => void }) {
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const add = async () => {
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            const configPath = await agentApi.addAccount(provider, trimmed);
            const profile: ProviderProfile = {
                id: `profile-${Date.now().toString(36)}`,
                name: trimmed,
                provider,
                accent: ACCENTS[provider],
                configPath,
                environmentKeys: [],
            };
            cmd.saveProviderProfile(profile);
            onDone();
            void signIn(profile);
        } catch (error) {
            reportError("Add account")(error);
            setBusy(false);
        }
    };
    return (
        <form
            className="agent-account adding"
            onSubmit={(event) => {
                event.preventDefault();
                void add();
            }}>
            <input
                autoFocus
                className="agent-account-name-input"
                aria-label={`New ${providerLabel} account name`}
                placeholder="Name it, like Work"
                value={name}
                disabled={busy}
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onDone();
                }}
            />
            <button type="submit" disabled={!name.trim() || busy}>
                Add and sign in
            </button>
        </form>
    );
}
