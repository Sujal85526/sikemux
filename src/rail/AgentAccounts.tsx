import { useEffect, useMemo, useState } from "react";
import { agentApi, type AgentUsage } from "../api/agents";
import { AccountSignIn } from "../agents/AccountSignIn";
import { accountsOf, signIn, signOut, useSignIn, type AccountProvider } from "../agents/accounts";
import { selectedProviderProfile } from "../agents/agentProfiles";
import { usePageVisible } from "../hooks/usePageVisible";
import * as cmd from "../state/commands";
import { invalidate, type ResourceHandle, useResource, useResourceEnabled } from "../state/resources";
import { agentAccountR, agentUsageR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import type { ProviderProfile } from "../state/types";
import { Switch } from "../ui/Controls";
import { IconMore, IconPlus, IconRefresh } from "../ui/Icons";
import { CountUp } from "../ui/RollingText";
import { Tooltip } from "../ui/Tooltip";
import { TreeContextMenu, type CtxItem } from "./FileTree";
import { planLabel, resetCountdown, resetTitle, usagePeak, usageTone } from "./usageFormat";

const USAGE_REFRESH_MS = 5 * 60_000;
const ACCENTS: Record<AccountProvider, string> = { claude: "#d97757", codex: "#7a9dff" };

function useMinuteClock(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

/**
 * The rail's footer: every account the person keeps with the provider, who
 * each is signed in as and how much it has left. The one new chats start on
 * shows its limits in full.
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
    const providerLabel = label ?? (provider === "claude" ? "Claude" : "Codex");
    const several = accounts.length > 1;

    const refresh = () => invalidate((kind, args) => (kind === "agents.account" || kind === "agents.usage") && args[0] === provider);

    return (
        <section className={`agent-usage agent-accounts ${provider}`} data-several={several || adding} aria-label={`${providerLabel} accounts`}>
            <div className="panel-head agent-usage-head">
                <span className="panel-label">{several ? "Accounts" : "Account"}</span>
                <span className="panel-rule" />
                <Tooltip label={`Refresh ${providerLabel} accounts and limits`}>
                    <button
                        type="button"
                        className="rail-group-add"
                        aria-label={`Refresh ${providerLabel} accounts and limits`}
                        disabled={usage.status === "loading"}
                        onClick={refresh}>
                        <IconRefresh size={11} />
                    </button>
                </Tooltip>
                <Tooltip label={`Add a ${providerLabel} account`}>
                    <button type="button" className="rail-group-add" aria-label={`Add a ${providerLabel} account`} onClick={() => setAdding(true)}>
                        <IconPlus size={11} />
                    </button>
                </Tooltip>
            </div>

            <div className="agent-accounts-list">
                {accounts.map((account) =>
                    account.id === current?.id ? (
                        <CurrentAccount key={account.id} provider={provider} account={account} usage={usage} several={several} />
                    ) : (
                        <OtherAccount key={account.id} provider={provider} account={account} command={command} />
                    ),
                )}
                {adding && <AddAccount provider={provider} providerLabel={providerLabel} onDone={() => setAdding(false)} />}
            </div>

            {several && (
                <label className="agent-accounts-switch">
                    <span>
                        <b>Move chats when one runs out</b>
                        <small>Carries a chat on to the next signed-in account at a usage limit.</small>
                    </span>
                    <Switch
                        checked={autoSwitch}
                        onChange={(on) => cmd.setAccountAutoSwitch(provider, on)}
                        label={`Move ${providerLabel} chats to another account at a usage limit`}
                    />
                </label>
            )}
        </section>
    );
}

function useAccountStatus(provider: AccountProvider, account: ProviderProfile) {
    return useResource(agentAccountR, provider, account.executablePath, account.configPath);
}

function accountMenu(provider: AccountProvider, account: ProviderProfile, current: boolean, signedIn: boolean): CtxItem[] {
    const items: CtxItem[] = [];
    if (!current) items.push({ label: "Use for new chats", run: () => cmd.selectProviderProfile(provider, account.id) });
    items.push({ label: signedIn ? "Sign in again" : "Sign in", run: () => void signIn(account) });
    if (signedIn) items.push({ label: "Sign out", run: () => void signOut(account).catch(reportError("Sign out")) });
    items.push({ sep: true }, { label: "Account settings…", run: () => cmd.openSettings("agents") });
    if (!account.id.startsWith("builtin-"))
        items.push({ label: "Remove from Sikemux", danger: true, run: () => cmd.deleteProviderProfile(account.id) });
    return items;
}

function AccountLine({
    provider,
    account,
    current,
    plan,
    peak,
}: {
    provider: AccountProvider;
    account: ProviderProfile;
    current: boolean;
    plan?: string | null;
    peak?: number;
}) {
    const status = useAccountStatus(provider, account);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const signedIn = status.data?.signedIn === true;
    const who = status.data?.email ?? (status.data && !signedIn ? "Signed out" : (status.data?.organization ?? null));
    const shownPlan = plan ?? status.data?.plan ?? null;
    const pick = () => {
        if (!current) cmd.selectProviderProfile(provider, account.id);
    };
    return (
        <div className="agent-account-line">
            <button
                type="button"
                className="agent-account-pick"
                disabled={current}
                aria-label={current ? `${account.name}, used for new chats` : `Use ${account.name} for new chats`}
                onClick={pick}>
                <span className="agent-account-mark" style={{ background: account.accent }} aria-hidden="true" />
                <span className="agent-account-name">{account.name}</span>
                {who && (
                    <span className="agent-account-who" data-signed-out={status.data && !signedIn ? "true" : undefined} title={who}>
                        {who}
                    </span>
                )}
            </button>
            {peak != null && (
                <Tooltip label={`${Math.round(peak)}% of its busiest limit used`}>
                    <span className="agent-account-peak" data-tone={usageTone(peak)}>
                        {Math.round(peak)}%
                    </span>
                </Tooltip>
            )}
            {shownPlan && <span className="agent-usage-plan">{planLabel(shownPlan)}</span>}
            <button
                type="button"
                className="agent-account-more"
                aria-label={`${account.name} account actions`}
                onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.right, y: box.bottom + 4 });
                }}>
                <IconMore size={12} />
            </button>
            {menu && (
                <TreeContextMenu
                    x={menu.x}
                    y={menu.y}
                    alignRight
                    items={accountMenu(provider, account, current, signedIn)}
                    onClose={() => setMenu(null)}
                />
            )}
        </div>
    );
}

function CurrentAccount({
    provider,
    account,
    usage,
    several,
}: {
    provider: AccountProvider;
    account: ProviderProfile;
    usage: ResourceHandle<AgentUsage>;
    several: boolean;
}) {
    const status = useAccountStatus(provider, account);
    const signing = useSignIn(account.id);
    const signedOut = status.data?.signedIn === false;
    return (
        <div className="agent-account current" data-signed-out={signedOut ? "true" : undefined}>
            {(several || status.data) && <AccountLine provider={provider} account={account} current plan={usage.data?.plan} />}
            {signedOut || signing ? <AccountSignIn profile={account} /> : <UsageWindows usage={usage} />}
        </div>
    );
}

function OtherAccount({ provider, account, command }: { provider: AccountProvider; account: ProviderProfile; command?: string }) {
    const visible = usePageVisible();
    const status = useAccountStatus(provider, account);
    const signing = useSignIn(account.id);
    const signedIn = status.data?.signedIn === true;
    const usage = useResourceEnabled(signedIn, agentUsageR, provider, command, account.configPath);
    const refresh = usage.refresh;
    useEffect(() => {
        if (!visible || !signedIn) return;
        const timer = window.setInterval(() => void refresh(), USAGE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [visible, signedIn, refresh]);
    return (
        <div className="agent-account" data-signed-out={status.data && !signedIn ? "true" : undefined}>
            <AccountLine provider={provider} account={account} current={false} plan={usage.data?.plan} peak={usagePeak(usage.data)} />
            {(signing || (status.data && !signedIn)) && <AccountSignIn profile={account} />}
        </div>
    );
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
