import { acpApi } from "../api/acp";
import { AccountSignIn } from "../agents/AccountSignIn";
import { accountsOf, acpAccount, isAccountProvider } from "../agents/accounts";
import { useResource } from "../state/resources";
import { agentAccountR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import type { Agent, ProviderProfile } from "../state/types";
import type { ChatFailure } from "./types";

/* Carries the chat on to `account`. The core sends the failed prompt again
   once the agent is up there. */
function moveTo(agent: Agent, account: ProviderProfile): void {
    void acpApi.switchAccount(agent.id, agent.type, acpAccount(account)).catch(reportError("Switch account"));
}

/** What the person can do about a turn that failed because of its account. */
export function ChatFailureActions({ agent, profile, failure }: { agent: Agent; profile: ProviderProfile; failure: ChatFailure }) {
    if (!isAccountProvider(profile.provider)) return null;
    if (failure.kind === "signIn") {
        return (
            <span className="chat-error-actions">
                <AccountSignIn profile={profile} label={`Sign in to ${profile.name}`} onSignedIn={() => moveTo(agent, profile)} />
            </span>
        );
    }
    if (failure.kind === "limit") return <ContinueElsewhere agent={agent} profile={profile} />;
    return null;
}

function ContinueElsewhere({ agent, profile }: { agent: Agent; profile: ProviderProfile }) {
    const profiles = useStore((s) => s.providerProfiles);
    const provider = isAccountProvider(profile.provider) ? profile.provider : "claude";
    const own = useResource(agentAccountR, provider, profile.executablePath, profile.configPath);
    const others = accountsOf(provider, profiles).filter((other) => other.id !== profile.id);
    if (others.length === 0 || !own.data?.sessions) return null;
    return (
        <span className="chat-error-actions">
            {others.map((other) => (
                <ContinueOn key={other.id} agent={agent} account={other} sessions={own.data!.sessions!} />
            ))}
        </span>
    );
}

/* Only an account that is signed in and keeps chats where this one does can
   take the chat over. */
function ContinueOn({ agent, account, sessions }: { agent: Agent; account: ProviderProfile; sessions: string }) {
    const provider = isAccountProvider(account.provider) ? account.provider : "claude";
    const status = useResource(agentAccountR, provider, account.executablePath, account.configPath);
    if (!status.data?.signedIn || status.data.sessions !== sessions) return null;
    return (
        <button type="button" onClick={() => moveTo(agent, account)}>
            Continue on {account.name}
        </button>
    );
}
